import {expect,it,vi} from 'vitest';
import {executeEvaluationCase} from '../src/evaluation/application/execute-case.js';
import {RuntimeCaseNotExecutedError,RuntimeExecutionFailure,type RuntimeExecutionRequest} from '../src/adapters.js';
import {EvaluationCancelledError} from '../src/runner.js';
import {evalCaseSchema,type RuntimeExecutionEvidence} from '../src/contracts.js';
import {evaluateMethods} from '../src/evaluation/application/evaluation-method.js';
import {checkExecutionEvidence} from '../src/evaluation/domain/execution-checks.js';

const evalCase=evalCaseSchema.parse({caseId:'dev',name:'Dev',prompt:'Query',evaluationGoal:'Answer',requiredTools:[],
  rubric:[{criterionId:'answer',label:'Answer',description:'Answer the question',dimension:'business_completeness',weight:1}]});
const request:RuntimeExecutionRequest={runId:'run',side:'right',evalCase,model:{providerId:'custom',modelId:'enterprise',parameters:{}},
  variant:{mode:'skill_version',skillId:'skill',version:'1',artifactSha256:'a'.repeat(64)}};
const evidence:RuntimeExecutionEvidence={runId:'run',caseId:'dev',side:'right',status:'completed',modelId:'enterprise',skillVersion:'1',
  output:'Answer',elapsedMs:1,toolCalls:[],loadedSkills:[{skillId:'skill',version:'1'}],usage:null,
  runtimeIdentityVerified:true,streamCompleted:true,metadata:{contentDigest:'candidate'}};

it('uses the exact custom runtime and retains diagnostic failure evidence in comparison mode',async()=>{
  const execute=vi.fn(async()=>evidence),runtime={adapterId:'enterprise',execute};
  expect(await executeEvaluationCase({runtime,request,failureMode:'throw'})).toBe(evidence);
  expect(execute).toHaveBeenCalledWith(request);
  execute.mockRejectedValueOnce(new RuntimeExecutionFailure('Execution failed',{processExit:2}));
  expect(await executeEvaluationCase({runtime,request,failureMode:'evidence'})).toMatchObject({status:'failed',metadata:{processExit:2},runtimeIdentityVerified:false});
  execute.mockRejectedValueOnce(new RuntimeCaseNotExecutedError('earlier'));
  expect(await executeEvaluationCase({runtime,request,failureMode:'evidence'})).toMatchObject({metadata:{executionDisposition:'NOT_EXECUTED',blockedByCaseId:'earlier'}});
});

it('does not turn cancellation into a failed business result',async()=>{
  const runtime={adapterId:'custom',execute:vi.fn(async()=>{throw new EvaluationCancelledError();})};
  await expect(executeEvaluationCase({runtime,request,failureMode:'evidence'})).rejects.toBeInstanceOf(EvaluationCancelledError);
  const controller=new AbortController();controller.abort();
  runtime.execute.mockClear();
  await expect(executeEvaluationCase({runtime,request:{...request,signal:controller.signal},failureMode:'evidence'})).rejects.toThrow();
  expect(runtime.execute).not.toHaveBeenCalled();
});

it('keeps rule and state failures visible alongside a passing Agent judgement',async()=>{
  const results=await evaluateMethods({evalCase,evidence},[
    {id:'rule',version:'1',kind:'RULE',evaluate:()=>[{id:'no-write',status:'FAIL',reason:'Unexpected write'}]},
    {id:'db',version:'2',kind:'STATE',evaluate:()=>[{id:'final-state',status:'UNVERIFIED',reason:'Missing state snapshot'}]},
    {id:'judge',version:'3',kind:'AGENT',evaluate:()=>[{id:'quality',status:'PASS',reason:'Answer correct'}]},
  ]);
  expect(results.map(r=>r.status)).toEqual(['FAIL','UNVERIFIED','PASS']);
  expect(results[1]).toMatchObject({methodId:'db',version:'2',kind:'STATE'});
  expect((await evaluateMethods({evalCase,evidence},[{id:'empty',version:'1',kind:'SCRIPT',evaluate:()=>[]}]))[0]?.status).toBe('UNVERIFIED');
});

it('does not accept a completed answer as proof of the requested candidate and skill group',()=>{
  const checks=checkExecutionEvidence(evidence,{contentDigest:'other-candidate',members:[{skillId:'skill',version:'2'}]});
  expect(checks.find(c=>c.id==='execution.completed')?.status).toBe('PASS');
  expect(checks.filter(c=>c.status==='UNVERIFIED').map(c=>c.id)).toEqual(['execution.artifact','execution.skill:skill@2']);
});

it('rejects ambiguous method identities before executing evaluators',async()=>{
  const evaluate=vi.fn(()=>[]),method={id:'duplicate',version:'1',kind:'RULE' as const,evaluate};
  await expect(evaluateMethods({evalCase,evidence},[method,method])).rejects.toThrow('Duplicate');
  expect(evaluate).not.toHaveBeenCalled();
});
