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

it('runs bounded optimizer, retains dependency bytes, rebinds candidate and hides holdout from editor',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'optimization-cycle-'));
 try {
  const skills=new SkillStore(dir);await skills.initialize();
  const body='---\nname: synthetic-method\nversion: 1.0.0\n---\nRead facts.';
  const original=await skills.uploadZip(Buffer.from(zipSync({'method/skill.md':strToU8(body),'helper.bin':new Uint8Array([0,255,7])})));
  const pack=await loadEvalPack('packs/finance/wealth-online/eval.yaml');
  const model={providerId:'controlled',modelId:'fixture',parameters:{}};
  const variant={mode:'skill_version' as const,skillId:original.skillId,version:original.version,artifactSha256:original.artifactSha256};
  const configuration=runConfigurationSchema.parse({packId:pack.packId,runtime:{type:'runtime_http',environmentId:'native'},executionModel:model,
   runtimeBindings:{left:{environmentId:'native',skillAssetId:original.assetId},right:{environmentId:'native',skillAssetId:original.assetId}},leftVariant:variant,rightVariant:variant});
  const evidence={status:'completed',output:'controlled result',toolCalls:[]};
  const cases=[...pack.cases.map(c=>({caseId:c.caseId,prompt:c.prompt,left:evidence,right:evidence,judge:{summary:'controlled review',dimensions:[]}})),
   {caseId:pack.holdoutCases![0]!.caseId,prompt:'HOLDOUT_SECRET_MARKER',left:evidence,right:evidence,judge:{summary:'HOLDOUT_SECRET_MARKER'}}];
  const report={models:{execution:{left:model,right:model}},variants:{left:variant,right:variant},cases};
  const source={jobId:'source',status:'completed',configuration,report};
  const get=vi.fn((id:string)=>id==='source'?source:{status:'completed',report});
  const create=vi.fn(async(_configuration:unknown)=>({jobId:'rerun'}));
  mocks.complete.mockResolvedValue({content:JSON.stringify({summary:'Controlled fixture, not professional acceptance',findings:['Clarify missing information'],
   changes:[{path:'SKILL.md',content:body+'\nDo not turn missing facts into zero.',reason:'Synthetic example'}]})});
  const manager=new OptimizationManager({dataDirectory:dir,skills,jobs:{get} as unknown as EvaluationJobStore,
   runs:{create,cancel:vi.fn()} as unknown as EvaluationRunManager,catalog:{get:()=>pack} as unknown as EvalPackCatalog});
  const item=await manager.create('source');
  await vi.waitFor(async()=>{const current=await manager.get(item.optimizationId);expect(current.status,current.error??'').toBe('review');});
  const done=await manager.get(item.optimizationId),candidate=done.candidate!;
  const archive=await skills.readArchive(candidate.assetId);
  expect(Buffer.from(archive['helper.bin']!)).toEqual(Buffer.from([0,255,7]));
  expect(archive['method/skill.md']).toBeDefined();expect(archive['SKILL.md']).toBeUndefined();
  expect(await skills.readSource(original.assetId)).toBe(body);
  expect(JSON.stringify(mocks.complete.mock.calls)).not.toContain('HOLDOUT_SECRET_MARKER');
  const rerun=create.mock.calls[0]![0] as any;
  expect(rerun.includeHoldout).toBe(true);
  expect(rerun.runtimeBindings.right.skillAssetId).toBe(candidate.assetId);
  expect(rerun.runtimeBindings.left.skillAssetId).toBe(original.assetId);
  expect((await manager.decide(item.optimizationId,'adopt')).status).toBe('adopted');
 } finally {mocks.complete.mockReset();await rm(dir,{recursive:true,force:true});}
});
