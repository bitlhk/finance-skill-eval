import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { strToU8, zipSync } from 'fflate';
import { expect, it, vi } from 'vitest';
import { SkillStore } from '../src/service/skill-store.js';
import { OptimizationManager } from '../src/service/optimization-manager.js';
import { runConfigurationSchema } from '../src/service/contracts.js';
import { loadEvalPack } from '../src/eval-pack.js';
import type { EvaluationJobStore } from '../src/service/job-store.js';
import type { EvaluationRunManager } from '../src/service/run-manager.js';
import type { EvalPackCatalog } from '../src/service/catalog.js';

const mocks=vi.hoisted(()=>({complete:vi.fn()}));
vi.mock('../src/service/config.js',()=>({configuredModelRole:()=>({model:{providerId:'controlled',modelId:'fixture',parameters:{}},adapter:{complete:mocks.complete}})}));

it.each([false,true])('runs bounded optimizer (continue on experiment: %s), preserves assets and hides holdout',async continueExperiment=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'optimization-cycle-'));
 let close=async()=>{};
 try {
  const skills=new SkillStore(dir);await skills.initialize();
  const body='---\nname: synthetic-method\nversion: 1.0.0\n---\nRead facts.';
  const original=await skills.uploadZip(Buffer.from(zipSync({'method/skill.md':strToU8(body),'helper.bin':new Uint8Array([0,255,7])})));
  const pack=await loadEvalPack('packs/finance/wealth-online/eval.yaml');
  const model={providerId:'controlled',modelId:'fixture',parameters:{}};
  const variant={mode:'skill_version' as const,skillId:original.skillId,version:original.version,artifactSha256:original.artifactSha256};
  const configuration=runConfigurationSchema.parse({packId:pack.packId,runtime:{type:'runtime_launcher',environmentId:'native'},executionModel:model,
   runtimeBindings:{left:{environmentId:'native',skillAssetId:original.assetId},right:{environmentId:'native',skillAssetId:original.assetId}},leftVariant:variant,rightVariant:variant});
  const evidence={status:'completed',runtimeIdentityVerified:true,streamCompleted:true,output:'controlled result',toolCalls:[]};
  const cases=[...pack.cases.map(c=>({caseId:c.caseId,prompt:c.prompt,left:evidence,right:evidence,judge:{summary:'controlled review',dimensions:[]}})),
   {caseId:pack.holdoutCases![0]!.caseId,prompt:'HOLDOUT_SECRET_MARKER',left:evidence,right:evidence,judge:{summary:'HOLDOUT_SECRET_MARKER'}}];
  for(const c of cases)c.judge.dimensions=[{id:'business_completeness',label:'Completeness',leftScore:2,rightScore:3,reason:'Observed'}] as never;
  const report={models:{execution:{left:model,right:model}},variants:{left:variant,right:variant},cases};
  const source={jobId:'source',status:'completed',configuration,report};
  let manualRegression=false;
  const get=vi.fn((id:string)=>{
    if(id==='source')return source;
    const request=create.mock.calls.at(-1)![0] as any;
    return {jobId:id,status:'completed',configuration,report:{...report,cases:cases.map((c,index)=>({...c,right:{...c.right,output:id},
      judge:manualRegression&&!request.includeHoldout&&index===0?{...c.judge,dimensions:[{id:'business_completeness',label:'Completeness',leftScore:2,rightScore:2,reason:'Edge case regression'}]}:c.judge})),variants:{left:request.leftVariant,right:request.rightVariant}}};
  });
  const create=vi.fn(async(_configuration:unknown)=>({jobId:`rerun-${create.mock.calls.length}`}));
  mocks.complete.mockImplementation(async(input:any)=>({content:JSON.stringify({summary:'Controlled fixture, not professional acceptance',findings:['Clarify missing information'],
   changes:[{path:'SKILL.md',content:JSON.parse(input.messages[1].content).files['SKILL.md']+'\nDo not turn missing facts into zero.',reason:'Synthetic example'}]})}));
  const agents={diagnose:vi.fn(async()=>({judgement:{status:'PROPOSED',hypothesis:{layer:'SKILL',issue:'Output gap',expectedBehavior:'Clarify',evidenceCaseIds:[pack.cases[0]!.caseId],validation:'Rerun',risk:'Low',confidence:'HIGH'}}} as any)),
    review:vi.fn(async()=>({status:'PRODUCED',review:{recommendation:'KEEP_CANDIDATE',reason:'Improved',improvements:['Clearer'],regressions:[],evidenceIds:[pack.cases[0]!.caseId]}} as any))};
  if(continueExperiment)agents.review.mockResolvedValueOnce({status:'PRODUCED',review:{recommendation:'CONTINUE_CANDIDATE',reason:'Needs further clarification',improvements:['Clearer'],regressions:[],evidenceIds:[pack.cases[0]!.caseId],nextFocus:['Explain missing facts more clearly']}});
  const manager=new OptimizationManager({dataDirectory:dir,skills,jobs:{get} as unknown as EvaluationJobStore,improvementAgents:()=>agents,
   runs:{create,cancel:vi.fn()} as unknown as EvaluationRunManager,catalog:{get:()=>pack} as unknown as EvalPackCatalog});
  const constraints='Preserve the approved workflow, state isolation and declared deployment requirements';
  close=()=>manager.close();
  const item=await manager.create('source',false,constraints,{maxRounds:continueExperiment?2:1});
  await vi.waitFor(async()=>{const current=await manager.get(item.optimizationId);expect(current.status,current.error??'').toBe('review');});
  const done=await manager.get(item.optimizationId),candidate=done.candidate!;
  expect(done.loop?.rounds[0]?.compositions?.some(c=>c.role==='adjustment')).toBe(true);
  expect(done.constraints).toBe(constraints);
  expect(JSON.parse(mocks.complete.mock.calls[0]![0].messages[1].content).constraints).toContain(constraints);
  const rounds=continueExperiment?2:1;
  expect(agents.diagnose).toHaveBeenCalledTimes(rounds);expect(agents.review).toHaveBeenCalledTimes(rounds);
  if(continueExperiment){
    expect(done.loop?.rounds[1]?.baseline).toEqual(done.loop?.rounds[0]?.candidate);
    const secondEdit=JSON.parse(mocks.complete.mock.calls[1]![0].messages[1].content);
    expect(secondEdit.developmentEvidence[0].answer).toBe('rerun-1');
    expect(secondEdit.files['SKILL.md']).toContain('Do not turn missing facts into zero.');
    expect(JSON.stringify(agents.diagnose.mock.calls[1])).toContain('Explain missing facts more clearly');
  }
  expect(JSON.stringify(agents.diagnose.mock.calls)+JSON.stringify(agents.review.mock.calls)).not.toContain('HOLDOUT_SECRET_MARKER');
  const archive=await skills.readArchive(candidate.assetId);
  expect(Buffer.from(archive['helper.bin']!)).toEqual(Buffer.from([0,255,7]));
  expect(archive['method/skill.md']).toBeDefined();expect(archive['SKILL.md']).toBeUndefined();
  expect(await skills.readSource(original.assetId)).toBe(body);
  expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain('HOLDOUT_SECRET_MARKER');
  const rerun=create.mock.calls[rounds-1]![0] as any;
  expect(rerun.includeHoldout).toBe(false);
  expect(rerun.runtimeBindings.right.skillAssetId).toBe(candidate.assetId);
  expect(rerun.runtimeBindings.left.skillAssetId).toBe(original.assetId);
  await expect(manager.decide(item.optimizationId,'adopt')).rejects.toThrow('留出集');
  if(continueExperiment){
    manualRegression=true;
    let finishReview!:()=>void;
    const reviewing=new Promise<void>(resolve=>{finishReview=resolve;});
    agents.review.mockImplementation(async()=>{await reviewing;return {status:'PRODUCED',review:{recommendation:'KEEP_CANDIDATE',reason:'Acceptable tradeoff for the goal',
      improvements:['Other task quality improves'],regressions:['One edge case regresses'],evidenceIds:[pack.cases[0]!.caseId],tradeoff:'Core outcome improvement outweighs this edge case'}};});
    await manager.reevaluate(item.optimizationId);
    await vi.waitFor(async()=>expect((await manager.get(item.optimizationId)).status).toBe('reviewing'));
    expect((await manager.get(item.optimizationId)).effectReview).toBeUndefined();
    finishReview();
    await vi.waitFor(async()=>expect((await manager.get(item.optimizationId)).status).toBe('review'));
    const refreshed=await manager.get(item.optimizationId);
    expect(refreshed.effectReview).toMatchObject({status:'PRODUCED',review:{recommendation:'KEEP_CANDIDATE',tradeoff:expect.any(String)}});
    expect(refreshed.reviewJobId).toBe(refreshed.rerunJobId);expect(agents.review).toHaveBeenCalledTimes(3);
  }
  await manager.finalVerify(item.optimizationId);
  await vi.waitFor(async()=>{const current=await manager.get(item.optimizationId);expect(current.status,current.error??'').toBe('review');expect(current.holdoutVerified).toBe(true)});
  expect((create.mock.calls[rounds+(continueExperiment?1:0)]![0] as any).includeHoldout).toBe(true);
  await expect(manager.reevaluate(item.optimizationId)).rejects.toThrow('留出集');
  expect((await manager.decide(item.optimizationId,'adopt')).status).toBe('adopted');
 } finally {await close();mocks.complete.mockReset();await rm(dir,{recursive:true,force:true});}
});

it.each(['PASS','FAIL','INDETERMINATE'] as const)('handles an expected negative tool result only with completed PASS evidence (%s)',async verdict=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'optimization-negative-'));
 let close=async()=>{};
 try{
  const skills=new SkillStore(dir);await skills.initialize();
  const body='---\nname: negative-case\nversion: 1.0.0\n---\nPreserve business rejection and include currency.';
  const asset=await skills.uploadZip(Buffer.from(zipSync({'SKILL.md':strToU8(body)})));
  const pack=await loadEvalPack('packs/finance/wealth-online/eval.yaml');
  const model={providerId:'controlled',modelId:'fixture',parameters:{}};
  const variant={mode:'skill_version' as const,skillId:asset.skillId,version:asset.version,artifactSha256:asset.artifactSha256};
  const configuration=runConfigurationSchema.parse({packId:pack.packId,evaluationMode:'candidate_assessment',runtime:{type:'runtime_launcher',environmentId:'native'},executionModel:model,
   runtimeBindings:{left:{environmentId:'native',skillAssetId:asset.assetId},right:{environmentId:'native',skillAssetId:asset.assetId}},leftVariant:variant,rightVariant:variant});
  const evidence={status:'completed',output:'Business record not found; do not invent a result.',toolCalls:[{status:'failed',name:'lookup'}]};
  const assessment={verdict,reason:'Business rejection is required',checks:[{criterion:'Reject missing records',verdict,reason:'Handled rejection',evidence:''}]};
  const report={models:{execution:{left:model,right:model}},variants:{left:variant,right:variant},cases:[{caseId:pack.cases[0]!.caseId,prompt:'Missing record',left:evidence,right:evidence,judge:{summary:'Review',dimensions:[],goalAssessment:assessment}}]};
  const source={jobId:'source',status:'completed',configuration,report};
  const runs={create:vi.fn(),cancel:vi.fn()};
  mocks.complete.mockResolvedValue({content:JSON.stringify({summary:'Clarify output',findings:['Missing currency'],changes:[{path:'SKILL.md',content:body+'\nReturn currency explicitly.',reason:'Output contract'}]})});
  const manager=new OptimizationManager({dataDirectory:dir,skills,jobs:{get:()=>source} as unknown as EvaluationJobStore,runs:runs as unknown as EvaluationRunManager,catalog:{get:()=>pack} as unknown as EvalPackCatalog});
  close=()=>manager.close();
  if(verdict!=='PASS')await expect(manager.propose('source')).rejects.toThrow('工具失败');
  else{
   // The stand-alone pairwise optimizer keeps its stronger prerequisite.
   await expect(manager.create('source')).rejects.toThrow('工具失败');
   const item=await manager.propose('source');
   await vi.waitFor(async()=>expect((await manager.get(item.optimizationId)).status).toBe('review'));
   expect(JSON.stringify(mocks.complete.mock.calls)).toContain('Reject missing records');
   expect(runs.create).not.toHaveBeenCalled();
   await expect(manager.finalVerify(item.optimizationId)).rejects.toThrow('持续改进任务');
  }
 }finally{await close();mocks.complete.mockReset();await rm(dir,{recursive:true,force:true});}
});
