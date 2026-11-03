import {expect,it,vi} from 'vitest';
import {evalCaseSchema,type RuntimeExecutionEvidence} from '../src/contracts.js';
import {evaluationPlanSchema} from '../src/evaluation/domain/evaluation-plan.js';
import {plannedMethods} from '../src/evaluation/application/planned-methods.js';
import {evaluateMethods} from '../src/evaluation/application/evaluation-method.js';
import {queryEvidence} from '../src/agents/evidence-query.js';
import {validateTelemetry} from '../src/evaluation/domain/telemetry.js';
import {validateArtifacts} from '../src/evaluation/domain/evidence-resources.js';
import {executeEvaluationCase} from '../src/evaluation/application/execute-case.js';
import {createCriterionJudge} from '../src/agents/criterion-judge.js';
import {rescoreTask} from '../src/migration/tasks/application/task-rescoring.js';
import type {BundleTask} from '../src/migration/tasks/domain/task-model.js';
import {EvaluationRunManager} from '../src/service/run-manager.js';
import {loadEvalPack} from '../src/eval-pack.js';
import type {EvaluationJob} from '../src/service/job-store.js';
import {evaluateComparison} from '../src/evaluation/application/evaluate-comparison.js';
import {evaluateTaskCase} from '../src/migration/tasks/application/evaluate-task-case.js';
import {hasCandidateFailures} from '../src/migration/tasks/domain/task-verdict.js';

const evalCase=evalCaseSchema.parse({caseId:'one',name:'one',prompt:'Calculate',evaluationGoal:'Correct amount',rubric:[{criterionId:'amount',label:'amount',description:'correct',dimension:'business_completeness',weight:1}]});
const evidence:RuntimeExecutionEvidence={runId:'run',caseId:'one',side:'right',status:'completed',modelId:'fixture',skillVersion:'1',output:'42',elapsedMs:1,toolCalls:[],loadedSkills:[],usage:null,error:null,runtimeIdentityVerified:true,streamCompleted:true,metadata:{}};
it('does not turn a Judge failure into evidence that candidate business logic is wrong',async()=>{
  const result=await evaluateTaskCase({evalCase,evidence,signal:new AbortController().signal,
    executionChecks:[{id:'execution.completed',status:'PASS',reason:'complete'}],judgeInput:{},
    judge:async()=>{throw Error('Invalid evidence citation');}});
  expect(result).toMatchObject({incomplete:true,judgeFailed:true,verdict:{passed:false,unverified:true}});
  expect(hasCandidateFailures({cases:[result.verdict]})).toBe(false);
  expect(result.methodResults[1]?.status).toBe('ERROR');
});
it('retries a transient Judge network failure once against the same saved evidence',async()=>{
  const judge=vi.fn().mockRejectedValueOnce(Object.assign(new Error('connection reset'),{code:'MODEL_NETWORK_ERROR'}))
    .mockResolvedValueOnce({passed:true,reason:'confirmed'});
  const result=await evaluateTaskCase({evalCase,evidence,signal:new AbortController().signal,
    executionChecks:[{id:'execution.completed',status:'PASS',reason:'complete'}],judgeInput:{},judge});
  expect(result).toMatchObject({incomplete:false,verdict:{passed:true}});
  expect(judge).toHaveBeenCalledTimes(2);
  expect(judge.mock.calls[0]![0].evidence).toEqual(judge.mock.calls[1]![0].evidence);
});
it('scores explicit execution criteria separately from answer preference and preserves unknowns',async()=>{
  const selected={...evalCase,rubric:[{...evalCase.rubric[0]!,scope:'execution' as const}]};
  const criterion=vi.fn(async({evidence:observed}:any)=>({passed:observed.side==='right',reason:'actual evidence',
    criteria:[{id:'amount',passed:observed.side==='right'?true:null,reason:'actual evidence',evidenceRefs:[]}]}));
  const judge={judgeId:'comparison',compare:vi.fn(async()=>({winner:'tie',confidence:'high',summary:'both answers clear',dimensions:[],reviewerLabel:'test'} as const)),executionCriteriaJudge:criterion};
  const result=await evaluateComparison({evalCase:selected,left:{...evidence,side:'left'},right:evidence,judge,profile:{} as any});
  expect(result.judge?.winner).toBe('tie');
  expect(result.methodResults?.left[0]?.status).toBe('UNVERIFIED');expect(result.methodResults?.right[0]?.status).toBe('PASS');
  expect(criterion).toHaveBeenCalledTimes(2);
  const unsupported=await evaluateComparison({evalCase:selected,left:{...evidence,side:'left'},right:evidence,
    judge:{judgeId:'answer-only',compare:judge.compare},profile:{} as any});
  expect(unsupported.methodResults?.right[0]?.status).toBe('UNVERIFIED');
});
it('checks numeric tolerances and unordered sets without coercing strings to numbers',async()=>{
  const plan=evaluationPlanSchema.parse({version:'1',checks:[
    {id:'amount',version:'1',kind:'RULE',rule:{operation:'numeric_tolerance',reference:'/state/amount',expected:100,absoluteTolerance:0.1}},
    {id:'members',version:'1',kind:'RULE',rule:{operation:'set_equals',reference:'/state/members',expected:['A','B']}},
  ]});
  const score=(state:unknown)=>evaluateMethods({evalCase,evidence:{...evidence,metadata:{state}}},plannedMethods(plan));
  expect((await score({amount:100.05,members:['B','A','A']})).map(r=>r.status)).toEqual(['PASS','PASS']);
  expect((await score({amount:'100',members:['A','C']})).map(r=>r.status)).toEqual(['FAIL','FAIL']);
  expect((await score({})).map(r=>r.status)).toEqual(['UNVERIFIED','UNVERIFIED']);
});
it('supports reference-based rules, script verdicts and state checks over one frozen execution',async()=>{
  const execute=vi.fn(async()=>({checks:[{id:'calculation',status:'PASS',reason:'42 verified',evidenceRefs:['/output'],score:1}]}));
  const plan=evaluationPlanSchema.parse({version:'1',checks:[
    {id:'answer',version:'1',kind:'RULE',rule:{operation:'equals',reference:'/output',expected:'42'}},
    {id:'script',version:'1',kind:'SCRIPT',script:'print(result)'},
    {id:'state',version:'1',kind:'STATE',script:'print(result)',evidenceRefs:['/state']},
  ]});
  const result=await evaluateMethods({evalCase,evidence},plannedMethods(plan,execute));
  expect(result.map(r=>r.status)).toEqual(['PASS','PASS','UNVERIFIED']);
  expect(execute).toHaveBeenCalledTimes(1);
});
it('distinguishes verifier malfunction from business failure and rejects invented citations',async()=>{
  const plan=evaluationPlanSchema.parse({version:'1',checks:[{id:'script',version:'1',kind:'SCRIPT',script:'pass'}]});
  const run=(execute:Parameters<typeof plannedMethods>[1])=>evaluateMethods({evalCase,evidence},plannedMethods(plan,execute));
  expect((await run(async()=>({checks:[{id:'a',status:'FAIL',reason:'Wrong result',evidenceRefs:['/output']}]})))[0]?.status).toBe('FAIL');
  expect((await run(async()=>{throw new Error('Container failed');}))[0]?.status).toBe('ERROR');
  expect((await run(async()=>({checks:[{id:'a',status:'PASS',reason:'Invented',evidenceRefs:['/missing']}]})))[0]?.status).toBe('ERROR');
  expect((await run(async()=>({checks:[{id:'a',status:'PASS',reason:'Unsupported',evidenceRefs:[]}]})))[0]?.status).toBe('UNVERIFIED');
});
it('bounds evidence queries, denies prototype traversal and keeps stable evidence digests',()=>{
  const data={file:'abcdefghijk'};
  const first=queryEvidence(data,{path:'/file',offset:0,limit:5});
  const second=queryEvidence(data,{path:'/file',offset:5,limit:5});
  expect(first).toMatchObject({available:true,nextOffset:5});
  expect('digest' in first&&'digest' in second&&first.digest===second.digest).toBe(true);
  expect(queryEvidence(data,{path:'/__proto__/constructor',offset:0,limit:10})).toMatchObject({available:false});
  expect(data).toEqual({file:'abcdefghijk'});
});
it('does not accept malformed or unrelated OTLP records as complete evidence',()=>{
  expect(validateTelemetry({status:'COMPLETE'}).status).toBe('UNAVAILABLE');
  const trace={status:'COMPLETE',source:'sdk',scope:'instrumented',otlp:{resourceSpans:[{scopeSpans:[{spans:[{
    traceId:'a'.repeat(32),spanId:'b'.repeat(16),name:'invoke_agent',startTimeUnixNano:'1',endTimeUnixNano:'2',
    attributes:[{key:'finance.run.id',value:{stringValue:'other'}}],
  }]}]}]}};
  expect(validateTelemetry(trace,{runId:'run',caseId:'one',side:'right'}).status).toBe('UNAVAILABLE');
});
it('rejects tampered artifact contents and keeps verifier code out of runtime requests',async()=>{
  expect(validateArtifacts([{path:'report.txt',content:'changed',sha256:'a'.repeat(64),source:'runtime'}])).toBeNull();
  const execute=vi.fn(async()=>structuredClone(evidence));
  await executeEvaluationCase({runtime:{adapterId:'fixture',execute},failureMode:'throw',request:{
    runId:'run',side:'right',model:{providerId:'fixture',modelId:'fixture',parameters:{}},variant:{mode:'without_target_skill',skillId:'s'},
    evalCase:{...evalCase,evaluationPlan:evaluationPlanSchema.parse({version:'1',checks:[{id:'secret-verifier',version:'1',kind:'SCRIPT',script:'HIDDEN_ANSWER'}]})},
  }});
  expect(JSON.stringify(execute.mock.calls)).not.toContain('HIDDEN_ANSWER');
});
it('lets the Judge investigate saved evidence, records usage, and validates its citations',async()=>{
  const complete=vi.fn().mockResolvedValueOnce({modelId:'judge',content:JSON.stringify({evidenceQuery:{path:'/output'}})})
    .mockResolvedValueOnce({modelId:'judge',usage:{totalTokens:20},content:JSON.stringify({criteria:[{id:'amount',passed:true,reason:'Verified',evidenceRefs:['/output']}]})});
  const judge=createCriterionJudge({adapter:{adapterId:'fixture',complete},model:{providerId:'fixture',modelId:'judge',parameters:{}}});
  const result=await judge({evalCase,evidence},{requestId:'judge'});
  expect(result.passed).toBe(true);expect(result.investigation).toHaveLength(3);
  expect(complete.mock.calls[1]![0].messages.at(-1).content).toContain('42');
});

it('advertises native process events to the execution Judge even when legacy toolCalls is empty',async()=>{
  const complete=vi.fn().mockResolvedValueOnce({modelId:'judge',content:JSON.stringify({evidenceQuery:{path:'/process/records'}})})
    .mockResolvedValueOnce({modelId:'judge',content:JSON.stringify({criteria:[{id:'amount',passed:true,reason:'Actual event result',evidenceRefs:['/process/records/0/data']}]})});
  const judge=createCriterionJudge({adapter:{adapterId:'fixture',complete},model:{providerId:'fixture',modelId:'judge',parameters:{}}});
  const observed={...evidence,metadata:{process:{schemaVersion:'finance.runtime-process.v1',status:'PARTIAL',scopes:['events'],
    reason:'Inputs unavailable',records:[{id:'event-1',kind:'event',name:'lookup',data:{amount:42}}]}}};
  expect(await judge({evalCase,evidence:observed},{requestId:'process-judge'})).toMatchObject({passed:true});
  const first=JSON.stringify(complete.mock.calls[0]);
  expect(first).toContain('/process/records');
  expect(first).toContain('PARTIAL');
  expect(JSON.stringify(complete.mock.calls[1])).toContain('amount');
});
it('exposes a successful retry beyond the bounded process preview',async()=>{
  const selected={...evalCase,rubric:evalCase.rubric.map(c=>({...c,scope:'execution' as const}))};
  const complete=vi.fn().mockResolvedValueOnce({modelId:'judge',content:JSON.stringify({evidenceQuery:{path:'/process/records/1/output'}})})
    .mockResolvedValueOnce({modelId:'judge',content:JSON.stringify({criteria:[{id:'amount',passed:true,reason:'Successful retry',evidenceRefs:['/process/records/1/output']}]})});
  const judge=createCriterionJudge({adapter:{adapterId:'fixture',complete},model:{providerId:'fixture',modelId:'judge',parameters:{}}});
  const observed={...evidence,metadata:{process:{records:[
    {id:'record-1',kind:'tool',name:'bash',status:'failed',output:'x'.repeat(8000)},
    {id:'record-2',kind:'tool',name:'bash',status:'completed',output:{exitCode:0,total:'42.00'}},
  ]}}};
  expect(await judge({evalCase:selected,evidence:observed},{requestId:'late-retry'})).toMatchObject({passed:true});
  const firstRequest=JSON.parse(complete.mock.calls[0]![0].messages[1].content);
  expect(firstRequest.evidence.processRecordIndex.entries[1]).toMatchObject({path:'/process/records/1',status:'completed'});
  expect(firstRequest.evidence.processPreview.content).not.toContain('42.00');
  expect(firstRequest.evidence.recentSuccessfulTools[0]).toMatchObject({
    path:'/process/records/1',content:expect.stringContaining('42.00'),
  });
  expect(JSON.stringify(complete.mock.calls[1])).toContain('42.00');
});
it('reserves the last investigation call for the verdict',async()=>{
  const complete=vi.fn(async(request)=>{
    const last=request.messages.at(-1).content;
    const content=last.includes('最后一次模型调用')
      ?{criteria:[{id:'amount',passed:true,reason:'Observed amount',evidenceRefs:['/output']}]}
      :{evidenceQuery:{path:'/output'}};
    return {modelId:'judge',content:JSON.stringify(content)};
  });
  const judge=createCriterionJudge({adapter:{adapterId:'fixture',complete},model:{providerId:'fixture',modelId:'judge',parameters:{}}});
  expect(await judge({evalCase,evidence},{requestId:'investigation-limit'})).toMatchObject({passed:true});
  expect(complete).toHaveBeenCalledTimes(8);
});
it('records evidence shortage as unverified rather than an invented business failure',async()=>{
  const judge=createCriterionJudge({adapter:{adapterId:'fixture',complete:async()=>({modelId:'judge',content:JSON.stringify({criteria:[{id:'amount',passed:null,reason:'Missing receipt',evidenceRefs:[]}]})})},model:{providerId:'fixture',modelId:'judge',parameters:{}}});
  expect(await judge({evalCase,evidence},{requestId:'judge'})).toMatchObject({passed:false,unverified:true});
});
it('identifies an invalid citation during correction without accepting invented evidence',async()=>{
  const complete=vi.fn().mockResolvedValueOnce({modelId:'judge',content:JSON.stringify({criteria:[{id:'amount',passed:true,reason:'Observed result',evidenceRefs:['/process/records/record-14']}]})})
    .mockResolvedValueOnce({modelId:'judge',content:JSON.stringify({criteria:[{id:'amount',passed:true,reason:'Observed 42',evidenceRefs:['/output']}]})});
  const judge=createCriterionJudge({adapter:{adapterId:'fixture',complete},model:{providerId:'fixture',modelId:'judge',parameters:{}}});
  expect(await judge({evalCase,evidence},{requestId:'citation-correction'})).toMatchObject({passed:true});
  expect(JSON.stringify(complete.mock.calls[1])).toContain('/process/records/record-14');
  expect(JSON.stringify(complete.mock.calls[1])).toContain('数组下标');
  complete.mockReset().mockResolvedValue({modelId:'judge',content:JSON.stringify({criteria:[{id:'amount',passed:true,reason:'Unsupported',evidenceRefs:['/invented']}]})});
  await expect(judge({evalCase,evidence},{requestId:'invalid-citation'})).rejects.toThrow('Judge 引用了不存在的证据');
  expect(complete).toHaveBeenCalledTimes(2);
});
it('preserves unknown requirement verdicts instead of converting them to failed requirements',async()=>{
  const judge=createCriterionJudge({adapter:{adapterId:'fixture',complete:async()=>({modelId:'judge',content:JSON.stringify({criteria:[
    {id:'amount',passed:true,reason:'Observed 42',evidenceRefs:['/output']},
    {id:'requirement:identity',passed:null,reason:'Identity not recorded',evidenceRefs:[]},
  ]})})},model:{providerId:'fixture',modelId:'judge',parameters:{}}});
  const result=await judge({evalCase,evidence,requirements:[{id:'identity'}]},{requestId:'judge'});
  expect(result.requirementResults).toEqual([{id:'identity',passed:null,reason:'Identity not recorded'}]);
  expect(result.unverified).toBe(true);
});
it('rescores frozen evidence without mutating the original run or invoking a runtime',async()=>{
  const source={id:'run',status:'FAILED',phase:'development',assessmentRequirements:[],suite:{name:'suite',cases:[{id:'one',input:'Calculate',criteria:['Correct']}]},cases:[{id:'one',passed:false,reason:'old',evidence}]};
  const task={runs:[source]} as unknown as BundleTask;
  const saved=structuredClone(task);
  const judge=vi.fn(async()=>({passed:true,reason:'New judgement'}));
  const result=await rescoreTask(task,{runId:'run'},judge,new AbortController().signal);
  expect(result.cases[0]?.status).toBe('PASS');expect(task).toEqual(saved);
  expect(result.sourceDigest).toMatch(/^[a-f0-9]{64}$/);expect(judge).toHaveBeenCalledTimes(1);
});

it('rescores a comparison using its frozen spec and retains the original report',async()=>{
  const pack=await loadEvalPack('packs/finance/investment-research/eval.yaml');
  pack.cases=pack.cases.slice(0,1);
  const caseInput=pack.cases[0]!;
  const original={reportFingerprint:'original',cases:[{caseId:caseInput.caseId,left:{...evidence,caseId:caseInput.caseId,side:'left'},right:{...evidence,caseId:caseInput.caseId}}]};
  let job={jobId:'test',status:'completed',configuration:{judgeMode:'deterministic'},evaluationSpec:pack,report:original} as unknown as EvaluationJob;
  const save=vi.fn(async(value:EvaluationJob)=>{job=structuredClone(value);return job;});
  const manager=new EvaluationRunManager({jobs:{get:()=>job,save},maxConcurrentRuns:1} as never);
  const result=await manager.rescore('test');
  expect(result.cases).toHaveLength(1);expect(result.cases[0]?.judge).not.toBeNull();
  expect(job.report).toEqual(original);expect(job.rescorings).toHaveLength(1);expect(save).toHaveBeenCalledTimes(1);
  delete job.evaluationSpec;
  await expect(manager.rescore('test')).rejects.toThrow('完整评判方案');
  await manager.close();
});
