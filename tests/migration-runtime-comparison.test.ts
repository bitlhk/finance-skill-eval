import {beforeAll,describe,expect,it,vi} from 'vitest';
import path from 'node:path';
import {loadEvalPack} from '../src/index.js';
import {judgeResultSchema,runtimeExecutionEvidenceSchema,type EvalPack} from '../src/contracts.js';
import {runConfigurationSchema} from '../src/shared/contracts/run-configuration.js';
import {MigrationEvaluationService} from '../src/migration/application/migration-evaluation-service.js';
import {parseMigrationProject,type MigrationProject} from '../src/migration/domain/migration-project.js';
import {ModelRuntimeComparisonJudge} from '../src/runtime-comparison-judge.js';
import {SideRuntimeAdapter} from '../src/side-runtime.js';
import {CandidateAssessmentRuntimeAdapter} from '../src/candidate-assessment-runtime.js';
import {EvaluationRunManager} from '../src/service/run-manager.js';
import {runEvaluation} from '../src/runner.js';
import type {ModelAdapter,RuntimeAdapter} from '../src/adapters.js';

const asset=(id:string,digest:string)=>({schemaVersion:'finance.skill-eval.skill-asset.v1' as const,assetId:id,skillId:'skill',version:'1',displayName:id,description:'',sourceType:'upload' as const,artifactSha256:digest.repeat(64),skillFile:'SKILL.md',fileCount:1,createdAt:'now'});
const candidate=asset('candidate','c'),source=asset('source','a');
const variant={mode:'skill_version' as const,skillId:candidate.skillId,version:candidate.version,artifactSha256:candidate.artifactSha256};
const leftModel={providerId:'runtime-launcher:left-env',modelId:'left-alias',parameters:{temperature:0,max_tokens:512}};
const rightModel={providerId:'runtime-launcher:right-env',modelId:'right-alias',parameters:{max_tokens:512,temperature:0}};
const configuration=()=>({packId:'test-pack',runtime:{type:'runtime_launcher',environmentId:'left-env'},
  evaluationMode:'candidate_runtime_comparison',judgeMode:'model',leftVariant:variant,rightVariant:variant,
  executionModel:leftModel,leftExecutionModel:leftModel,rightExecutionModel:rightModel,
  runtimeBindings:{left:{environmentId:'left-env',skillAssetId:candidate.assetId},right:{environmentId:'right-env',skillAssetId:candidate.assetId}}});
const plan=()=>({pair:'CC',configuration:configuration(),dataSnapshot:'snapshot',permissionBasis:'test',sourceProjectRef:'source-ref',dependencyLockRef:'lock'});
let pack:EvalPack;
beforeAll(async()=>{
  pack=await loadEvalPack(path.resolve('packs/finance/investment-research/eval.yaml'));
  pack={...pack,packId:'test-pack',metadata:{...pack.metadata,assessmentMode:'natural_language'},cases:[{...pack.cases[0]!,rubric:[{...pack.cases[0]!.rubric[0]!,description:'Answer meets the goal'}]}]};
});
function serviceFixture(){
  const project:MigrationProject={schemaVersion:'finance.skill-migration.v2',id:'migration-aaaa',name:'CC',createdAt:'now',source,candidate,candidateNotes:'',runs:[],assessment:'NOT_VALIDATED'};
  const create=vi.fn(async()=>({jobId:'job'}));
  const save=vi.fn(async()=>{});
  const service=new MigrationEvaluationService({runExclusive:async(_id,fn)=>fn(),get:async()=>project,save} as any,
    {create} as any,{get:()=>pack},undefined,undefined,undefined,{get:async()=>({revision:1,values:{},checks:[]})} as any);
  return {project,create,save,service};
}
const evidence=(side:'left'|'right',output=side)=>runtimeExecutionEvidenceSchema.parse({runId:'run',caseId:pack.cases[0]!.caseId,side,status:'completed',modelId:side,skillVersion:'1',output,elapsedMs:1,runtimeIdentityVerified:true,streamCompleted:true,error:null});
const goalAdapter=(requests:any[]=[],failLeft=false):ModelAdapter=>({adapterId:'goals',complete:async request=>{
  requests.push(request);
  const payload=JSON.parse(request.messages[1]!.content);
  if(failLeft&&payload.answer==='left')throw Error('left judge unavailable');
  return {modelId:'judge',content:JSON.stringify({checks:[{criterionIndex:0,verdict:payload.answer==='left'?'FAIL':'PASS',reason:'goal check',evidence:payload.answer}]})};
}});
const judgeInput=()=>({evalCase:pack.cases[0]!,left:evidence('left'),right:evidence('right'),profile:pack.judgeProfile});

describe('CC contract and candidate identity',()=>{
  it('preserves different environment model aliases with identical actual parameters',()=>{
    const parsed=runConfigurationSchema.parse(configuration());
    expect(parsed.leftExecutionModel).toEqual(leftModel);expect(parsed.rightExecutionModel).toEqual(rightModel);
  });
  it('accepts frozen holdout cases without relaxing the paired candidate contract',()=>{
    expect(runConfigurationSchema.parse({...configuration(),includeHoldout:true}).includeHoldout).toBe(true);
    expect(runConfigurationSchema.safeParse({...configuration(),includeHoldout:true,caseSource:'ai_generated'}).success).toBe(false);
    expect(runConfigurationSchema.safeParse({...configuration(),includeHoldout:true,
      rightVariant:{...variant,artifactSha256:source.artifactSha256}}).success).toBe(false);
  });
  it.each(['executionModel','leftExecutionModel','rightExecutionModel','leftVariant','rightVariant','runtimeBindings'])('rejects missing %s as schema validation',key=>{
    const input:any=configuration();delete input[key];expect(runConfigurationSchema.safeParse(input).success).toBe(false);
  });
  it('rejects changed parameters, variants, assets, same environments, wrong primary and non-model judging',()=>{
    for(const mutate of [
      (c:any)=>c.rightExecutionModel={...rightModel,parameters:{temperature:1}},
      (c:any)=>c.rightVariant={...variant,artifactSha256:source.artifactSha256},
      (c:any)=>c.runtimeBindings.left.skillAssetId='source',
      (c:any)=>c.runtimeBindings.right.environmentId='left-env',
      (c:any)=>c.executionModel=rightModel,
      (c:any)=>c.runtime.environmentId='right-env',
      (c:any)=>c.judgeMode='deterministic',
    ]){const c=structuredClone(configuration());mutate(c);expect(runConfigurationSchema.safeParse(c).success).toBe(false)}
  });
  it('does not relax legacy model restrictions',()=>{
    for(const evaluationMode of ['pairwise','candidate_assessment'])expect(runConfigurationSchema.safeParse({...configuration(),evaluationMode}).success).toBe(false);
  });
  it('creates CC against the current candidate on both sides and persists it',async()=>{
    const f=serviceFixture();await f.service.validate(f.project.id,plan());
    expect(f.create).toHaveBeenCalledOnce();expect(f.project.runs[0]?.pair).toBe('CC');
    expect(parseMigrationProject(JSON.parse(JSON.stringify(f.project))).runs[0]?.declaredPlan?.configuration.rightExecutionModel).toEqual(rightModel);
  });
  it.each(['source','stale'])('rejects two identical %s bindings instead of comparing source/candidate',async kind=>{
    const f=serviceFixture(),p=plan(),bound=kind==='source'?source:asset('stale','b');
    for(const side of ['left','right'] as const){p.configuration.runtimeBindings[side].skillAssetId=bound.assetId;p.configuration[side==='left'?'leftVariant':'rightVariant']={...variant,artifactSha256:bound.artifactSha256}}
    await expect(f.service.validate(f.project.id,p)).rejects.toThrow('冻结');expect(f.create).not.toHaveBeenCalled();expect(f.save).not.toHaveBeenCalled();
  });
  it('rejects CC mode/pair mismatch and original-service-only goals before creating a job',async()=>{
    const f=serviceFixture();await expect(f.service.validate(f.project.id,{...plan(),pair:'AC'})).rejects.toThrow('CC');
    const original=pack;pack={...pack,metadata:{...pack.metadata,comparisonOnly:'true'}};
    try{await expect(f.service.validate(f.project.id,plan())).rejects.toThrow('原服务')}finally{pack=original}
    expect(f.create).not.toHaveBeenCalled();
  });
  it('fingerprints environment and actual model changes',async()=>{
    const f=serviceFixture(),first=await f.service.validate(f.project.id,plan()),p=plan();
    p.configuration.rightExecutionModel={...rightModel,modelId:'another-alias'};
    const second=await f.service.validate(f.project.id,p);expect(second.comparisonFingerprint).not.toBe(first.comparisonFingerprint);
    p.configuration.runtimeBindings.right.environmentId='third-env';
    expect((await f.service.validate(f.project.id,p)).comparisonFingerprint).not.toBe(second.comparisonFingerprint);
  });
});

describe('independent Runtime goal assessment',()=>{
  it('reuses goal judging with isolated answers and tool evidence, without a winner',async()=>{
    const requests:any[]=[],input=judgeInput();
    input.left.metadata={toolEvidence:[{tool:'business-left',fact:'left-only'}],
      toolEvidenceCollection:{status:'PARTIAL',reason:'VERIFIED_NON_COMPLETED_RESULTS',
        nonCompletedResults:[{resultStatus:'FAILED',resultIndex:0}]}};
    input.right.metadata={toolEvidence:[{tool:'business-right',fact:'right-only'}]};
    const result=await new ModelRuntimeComparisonJudge(goalAdapter(requests),leftModel).compare(input);
    expect(result.runtimeComparison?.left).toMatchObject({status:'assessed',assessment:{verdict:'FAIL'}});
    expect(result.runtimeComparison?.right).toMatchObject({status:'assessed',assessment:{verdict:'PASS'}});
    expect(result.winner).toBeUndefined();expect(result.goalAssessment).toBeUndefined();expect(result.dimensions).toEqual([]);
    expect(requests).toHaveLength(2);expect(requests[0].requestId).not.toBe(requests[1].requestId);
    expect(JSON.parse(requests[0].messages[1].content).runtimeEvidence.sourceFacts).toEqual(input.left.metadata.toolEvidence);
    expect(JSON.parse(requests[0].messages[1].content).runtimeEvidence.sourceFactsCollection).toEqual(input.left.metadata.toolEvidenceCollection);
    expect(JSON.parse(requests[1].messages[1].content).runtimeEvidence.sourceFactsCollection).toBeUndefined();
    expect(JSON.stringify(requests[0])).not.toContain('right-only');expect(JSON.stringify(requests[1])).not.toContain('left-only');
    expect(judgeResultSchema.safeParse({...result,winner:'tie'}).success).toBe(false);
    expect(judgeResultSchema.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
  });
  it('keeps per-side business clocks separate and identifies the new judging policy',async()=>{
    const requests:any[]=[],input=judgeInput();
    for(const side of ['left','right'] as const)input[side].metadata={executionMode:'runtime-launcher',
      businessDate:side==='left'?'2026-09-05':'2026-09-06',businessTimeZone:'Asia/Shanghai',businessDateBasis:'VERSIONED_SYNTHETIC_DATASET'};
    const judge=new ModelRuntimeComparisonJudge(goalAdapter(requests),leftModel);
    expect(judge.judgeId).toContain('model-runtime-goals:fact-provenance-v2:');
    await judge.compare(input);
    expect(requests.map(request=>JSON.parse(request.messages[1].content).runtimeEvidence.businessTime.businessDate))
      .toEqual(['2026-09-05','2026-09-06']);
  });
  it('retains the healthy side after execution or judge failure',async()=>{
    for(const runtimeFailure of [true,false]){
      const requests:any[]=[],input=judgeInput();if(runtimeFailure)input.left.status='failed';
      const result=await new ModelRuntimeComparisonJudge(goalAdapter(requests,!runtimeFailure),leftModel).compare(input);
      expect(result.runtimeComparison?.left.status).toBe('unavailable');
      expect(result.runtimeComparison?.right).toMatchObject({status:'assessed',assessment:{verdict:'PASS'}});
      expect(requests.length).toBe(runtimeFailure?1:3);
    }
  });
  it('does not swallow cancellation',async()=>{
    const controller=new AbortController();controller.abort();
    await expect(new ModelRuntimeComparisonJudge(goalAdapter(),leftModel).compare({...judgeInput(),signal:controller.signal})).rejects.toThrow();
  });
  it('preserves per-side model refs and candidate variants in the resolved execution pack',async()=>{
    const manager=new EvaluationRunManager({catalog:{get:()=>pack}} as any);
    const resolved=await (manager as any).resolvePack(runConfigurationSchema.parse(configuration()));
    expect(resolved.models.execution).toEqual({left:leftModel,right:rightModel});expect(resolved.variants).toEqual({left:variant,right:variant});
  });
  it('runs the same frozen development and holdout inputs on both sides',async()=>{
    const holdout={...pack.cases[0]!,caseId:'held-out-case',prompt:'Unseen fixed question'};
    const sourcePack={...pack,holdoutCases:[holdout]};
    const manager=new EvaluationRunManager({catalog:{get:()=>sourcePack}} as any);
    const resolved=await (manager as any).resolvePack(runConfigurationSchema.parse({...configuration(),includeHoldout:true}));
    expect(resolved.cases).toEqual([...pack.cases,holdout]);
    expect(sourcePack.cases).toHaveLength(1);
    const execute=vi.fn(async(request:any)=>({...evidence(request.side),caseId:request.evalCase.caseId,runId:request.runId}));
    const cleanup=vi.fn(async()=>{});
    const runtime=new SideRuntimeAdapter({left:{adapterId:'left-env',execute,cleanup},right:{adapterId:'right-env',execute,cleanup}});
    const report=await runEvaluation({pack:resolved,runtime,judge:new ModelRuntimeComparisonJudge(goalAdapter(),leftModel)});
    expect(report.cases).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(4);
    for(const testCase of resolved.cases){
      const calls=execute.mock.calls.map(([request])=>request).filter(request=>request.evalCase.caseId===testCase.caseId);
      expect(calls.map(request=>request.side).sort()).toEqual(['left','right']);
      expect(calls[0].evalCase).toEqual(calls[1].evalCase);
    }
    expect(cleanup).toHaveBeenCalledTimes(2);
  });
  it('rejects missing or conflicting holdout cases before preparing either Runtime',async()=>{
    const config=runConfigurationSchema.parse({...configuration(),includeHoldout:true});
    for(const holdoutCases of [[],[pack.cases[0]!]]){
      const manager=new EvaluationRunManager({catalog:{get:()=>({...pack,holdoutCases})}} as any);
      await expect((manager as any).resolvePack(config)).rejects.toThrow(/留出题/);
    }
  });
  it('runs both candidate sides exactly once and retains healthy-side assessment in the runner report',async()=>{
    const execute=vi.fn(async(request:any)=>{
      if(request.side==='left')throw Error('left runtime failed');
      return {...evidence('right'),runId:request.runId};
    });
    const cleanup=vi.fn(async()=>{}),runtime=new SideRuntimeAdapter({left:{adapterId:'left-env',execute,cleanup},right:{adapterId:'right-env',execute,cleanup}});
    const report=await runEvaluation({pack:{...pack,variants:{left:variant,right:variant},models:{...pack.models,execution:{left:leftModel,right:rightModel}}},runtime,judge:new ModelRuntimeComparisonJudge(goalAdapter(),leftModel)});
    expect(execute).toHaveBeenCalledTimes(2);expect(cleanup).toHaveBeenCalledTimes(2);
    for(const side of ['left','right'] as const){const request=execute.mock.calls.find(([r])=>r.side===side)![0];expect(request.variant).toEqual(variant);expect(request.model).toEqual(side==='left'?leftModel:rightModel)}
    expect(report.cases[0]?.judge?.runtimeComparison?.left.status).toBe('unavailable');
    expect(report.cases[0]?.judge?.runtimeComparison?.right).toMatchObject({status:'assessed',assessment:{verdict:'PASS'}});
    expect(report.summary.ties).toBe(0);
  },30_000);
  it('keeps BC right-only execution unchanged',async()=>{
    const execute=vi.fn(async()=>evidence('right'));
    const adapter=new CandidateAssessmentRuntimeAdapter({adapterId:'BC',execute} as RuntimeAdapter,variant,rightModel);
    for(const side of ['left','right'] as const)await adapter.execute({runId:'run',side,evalCase:pack.cases[0]!,variant,model:rightModel});
    expect(execute).toHaveBeenCalledOnce();expect(execute.mock.calls[0]).toMatchObject([{side:'right'}]);
  });
});
