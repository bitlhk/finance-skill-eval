import {beforeEach,expect,it,vi} from 'vitest';
import {EvaluationRunManager} from '../src/service/run-manager.js';
import {runConfigurationSchema} from '../src/shared/contracts/run-configuration.js';
import {loadEvalPack} from '../src/eval-pack.js';
import {runEvaluation} from '../src/runner.js';
import {comparisonExecutionIncomplete} from '../src/evaluation/application/comparison-executions.js';
import {OptimizationManager} from '../src/service/optimization-manager.js';
import {DeterministicRubricJudge} from '../src/judge.js';
vi.mock('../src/runner.js',async original=>({...await original<object>(),runEvaluation:vi.fn()}));
const evidence={status:'completed',streamCompleted:true,runtimeIdentityVerified:true,metadata:{},output:'answer'};
const report=()=>({reportFingerprint:'old',cases:[{caseId:'a',left:structuredClone(evidence),right:structuredClone(evidence),judge:{winner:'left',dimensions:[]},judgeError:null}]}) as any;
beforeEach(()=>{vi.mocked(runEvaluation).mockReset();});
async function fixture(extra:Record<string,unknown>={}){
  const pack=await loadEvalPack('packs/finance/investment-research/eval.yaml');pack.cases=pack.cases.slice(0,1);
  const job:any={jobId:'run',status:'queued',configuration:runConfigurationSchema.parse({packId:pack.packId,runtime:{type:'direct_model'},executionRepetitions:3,repeatSafety:'read_only',...extra}),progress:{completedRuns:0,totalRuns:0},evidence:[],report:null,error:null};
  let stored=structuredClone(job);
  const manager=new EvaluationRunManager({jobs:{get:()=>stored,save:async(value:any)=>{stored=structuredClone(value);return stored;},updateLive:()=>{}},maxConcurrentRuns:1} as any);
  vi.spyOn(manager as any,'resolvePack').mockResolvedValue(pack);
  const runtime=vi.spyOn(manager as any,'runtimeFor').mockResolvedValue({adapterId:'test'});
  vi.spyOn(manager as any,'judgeFor').mockResolvedValue(new DeterministicRubricJudge());
  const controller=new AbortController();
  return {job,runtime,controller,run:()=> (manager as any).execute(job,controller),get:()=>stored};
}
it('runs the frozen suite three times with distinct runtime acquisition and saved reports',async()=>{
  const f=await fixture();vi.mocked(runEvaluation).mockImplementation(async input=>{input.onProgress?.({stage:'completed',completedRuns:2,totalRuns:2} as any);return report();});
  await f.run();expect(f.runtime).toHaveBeenCalledTimes(3);
  expect(f.get()).toMatchObject({status:'completed',progress:{completedRuns:6,totalRuns:6}});
  expect(f.get().executionAttempts.map((a:any)=>a.status)).toEqual(['COMPLETED','COMPLETED','COMPLETED']);
  expect(new Set(vi.mocked(runEvaluation).mock.calls.map(([input])=>input.pack))).toHaveProperty('size',1);
});
it('rejects unsafe repeats before any business call',async()=>{
  const f=await fixture({repeatSafety:undefined});await f.run();expect(f.get().status).toBe('failed');expect(f.runtime).not.toHaveBeenCalled();
  expect(runConfigurationSchema.safeParse({packId:'p',runtime:{type:'replay'},executionRepetitions:2}).success).toBe(false);
});
it('stops on uncertain execution but continues for an explicit business failure',async()=>{
  const f=await fixture();const failed=report();failed.cases[0].judge.goalAssessment={verdict:'FAIL'};
  const unknown=report();unknown.cases[0].right.metadata.caseState={status:'INCOMPLETE'};
  vi.mocked(runEvaluation).mockResolvedValueOnce(failed).mockResolvedValueOnce(unknown);
  await f.run();expect(f.runtime).toHaveBeenCalledTimes(2);expect(f.get().executionAttempts).toHaveLength(2);
  expect(f.get().executionRepetitionsStopped).toBeTruthy();expect(comparisonExecutionIncomplete(failed)).toBe(false);
});
it('preserves completed attempts when the next runtime fails',async()=>{
  const f=await fixture();vi.mocked(runEvaluation).mockResolvedValueOnce(report()).mockRejectedValueOnce(new Error('offline'));
  await f.run();expect(f.get().status).toBe('failed');expect(f.get().executionAttempts.map((a:any)=>a.status)).toEqual(['COMPLETED','FAILED']);
});
it('stops scheduling business calls after cancellation',async()=>{
  const f=await fixture();vi.mocked(runEvaluation).mockImplementationOnce(async()=>{f.controller.abort();return report();});
  await f.run();expect(f.runtime).toHaveBeenCalledTimes(1);expect(f.get().status).toBe('cancelled');
});
it('never lets the last successful repetition hide a failure or a missing attempt from optimization',()=>{
  const manager=new OptimizationManager({dataDirectory:'.'} as any);
  const successful=report();successful.variants={right:{mode:'skill_version',artifactSha256:'digest'}};
  successful.cases[0].judge.goalAssessment={verdict:'PASS'};
  const failed=structuredClone(successful);failed.cases[0].judge.goalAssessment.verdict='FAIL';
  const job={jobId:'run',configuration:{executionRepetitions:2},report:successful,executionAttempts:[{index:0,status:'COMPLETED',report:failed},{index:1,status:'COMPLETED',report:successful}]};
  const view=()=> (manager as any).evaluationView(job,{id:'candidate',digest:'digest'},['a'],'protocol');
  expect(view().cases[0].passed).toBe(false);
  job.executionAttempts.shift();expect(view().cases[0].passed).toBeNull();
});
it('uses the real runner lifecycle for repeated business execution with separate run IDs and cleanup',async()=>{
  const actual=await vi.importActual<typeof import('../src/runner.js')>('../src/runner.js');
  const f=await fixture({executionRepetitions:2});const ids=new Set<string>(),cleanup=vi.fn(async()=>{});
  const cleanupCountsAtJudgement:number[]=[];
  vi.mocked(runEvaluation).mockImplementation(input=>actual.runEvaluation({...input,judge:{
    judgeId:input.judge.judgeId,
    compare:request=>{
      cleanupCountsAtJudgement.push(cleanup.mock.calls.length);
      return input.judge.compare(request);
    },
  }}));
  f.runtime.mockImplementation(async()=>({adapterId:'controlled-business-runtime',cleanup,
    execute:async(request:any)=>{
      ids.add(request.runId);
      return {...evidence,runId:request.runId,caseId:request.evalCase.caseId,side:request.side,modelId:request.model.modelId,
        skillVersion:'1',elapsedMs:1,toolCalls:[],loadedSkills:[],usage:null,error:null};
    }}));
  await f.run();expect(f.get().error).toBeNull();expect(f.get().executionAttempts).toHaveLength(2);
  expect(ids.size).toBe(2);expect(cleanup).toHaveBeenCalledTimes(2);
  expect(cleanupCountsAtJudgement).toEqual([1,2]);
},60000);
