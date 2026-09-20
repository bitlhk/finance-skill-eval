import { mkdtemp,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8,zipSync } from 'fflate';
import { afterEach,expect,it,vi } from 'vitest';
import { loadEvalPack } from '../src/eval-pack.js';
import { buildMigrationPlan } from '../src/service/migration-model.js';
import { MigrationDiagnostics } from '../src/service/migration-diagnostics.js';
import { MigrationStore } from '../src/service/migration-store.js';
import { SkillStore } from '../src/service/skill-store.js';
import type { EvaluationJobStore } from '../src/service/job-store.js';
import type { EvaluationRunManager } from '../src/service/run-manager.js';
import type { OptimizationManager } from '../src/service/optimization-manager.js';
import type { EnvironmentStore } from '../src/service/environment-store.js';
import type { EvalPackCatalog } from '../src/service/catalog.js';
import { analysisFixture,analyzedTool,implementationFixture } from './analysis-fixture.js';

const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

const LOOKUP_PY='import json,sys\ndef lookup(value): return {"value": value}\nif __name__ == "__main__": json.dump(lookup(json.load(sys.stdin)),sys.stdout)\n';
const OPTIMIZED_LOOKUP_PY='import json,sys\ndef lookup(value): return {"value": value, "checked": True}\nif __name__ == "__main__": json.dump(lookup(json.load(sys.stdin)),sys.stdout)\n';

/**
 * One migration, all the way down the chain: baseline → candidate → technical validation →
 * OpenJiuwen evaluation → optimization → adoption.
 *
 * Every step before this test was covered on its own; what was never covered is the *seam*
 * between them -- which evidence each step demands from the one before, and what stops being
 * trusted once the candidate it described is replaced. That is the part a segment test cannot
 * reach, so this one runs the whole store with the three live dependencies it cannot have here
 * (a Runtime HTTP Host, the evaluation runner, the optimizer) standing in as fakes. The
 * optimizer's own cycle is a real, separately tested service (tests/optimization-cycle.test.ts);
 * what is under test here is what this store does with its result.
 */
it('carries a migration from baseline to adopted optimization and retires the evidence for the candidate it replaced',async()=>{
  vi.stubEnv('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS','1');
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-chain-'));dirs.push(data);
  const skills=new SkillStore(data);await skills.initialize();
  const pack=await loadEvalPack('packs/finance/wealth-online/eval.yaml');

  const configurations=new Map<string,Record<string,never>>();
  let counter=0,optimization:unknown=null;
  const runs={create:async(configuration:unknown)=>{const jobId=`job-${++counter}`;configurations.set(jobId,configuration as Record<string,never>);return {jobId};}} as unknown as EvaluationRunManager;
  const jobs={get:(jobId:string)=>{
    const configuration=configurations.get(jobId);if(!configuration)return null;
    const variants=configuration as unknown as {leftVariant:unknown;rightVariant:unknown};
    return {jobId,status:'completed',configuration,report:{variants:{left:variants.leftVariant,right:variants.rightVariant},models:null,cases:[]}};
  }} as unknown as EvaluationJobStore;
  const environments={get:async(environmentId:string)=>environmentId==='env-openjiuwen'
    ?{environmentId,name:'开放居问目标',type:'runtime_http',runtimeType:'openjiuwen',endpoint:'http://127.0.0.1:1/execute',credentialEnv:null,mcpEnvironmentIds:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}
    :null} as unknown as EnvironmentStore;
  const catalog={get:(packId:string)=>packId===pack.packId?pack:null} as unknown as EvalPackCatalog;
  const optimizers={
    create:async(sourceJobId:string)=>({optimizationId:'opt-1',sourceJobId,status:'diagnosing',candidate:null,summary:''}),
    get:async(optimizationId:string)=>optimizationId==='opt-1'?optimization:null,
  } as unknown as OptimizationManager;

  const store=new MigrationStore(data,skills,runs,jobs,catalog,undefined,optimizers,
    new MigrationDiagnostics(path.resolve('.'),data,skills),environments,
    undefined,
    // The A2 stand-in cites the Script where it actually is. The source keeps the layout it was
    // written in; the optimized package ships one where the platform places it.
    async input=>{
      const path=Object.keys(input.files).find(name=>/(^|\/)lookup\.py$/u.test(name))??'tool/scripts/lookup.py';
      return await analysisFixture([analyzedTool({name:'lookup',sourcePaths:[path],portability:'PORTABLE_SCRIPT',form:'SCRIPT',entrypoint:{kind:'PYTHON',path}})])(input);
    },
    implementationFixture([{tool:'lookup',entrypoint:'scripts/lookup.py',language:'python',files:{'scripts/lookup.py':LOOKUP_PY}}]),
    undefined,{environment:(id:string)=>environments.get(id)} as never);

  const upload=async(files:Record<string,string>)=>{
    const zip=Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name,content])=>[name,strToU8(content)]))));
    return await skills.uploadMigrationZip(zip);
  };

  const source=await upload({
    'skill/SKILL.md':'---\nname: chain-lookup\ndescription: 端到端链路夹具，查询账户余额。\n---\n调用 `lookup`，传入 account_id。\n成功时返回币种与账面余额。\n',
    'tool/scripts/lookup.py':LOOKUP_PY,
  });
  const project=await store.create({sourceAssetId:source.assetId,name:'chain'});

  // A2: the baseline. Without it there is no Tool list, so nothing downstream has anything to
  // decide about -- which is why every later step is gated on this having run.
  const inspection=await store.inspect(project.id);
  expect(inspection.tools.map(tool=>tool.name)).toEqual(['lookup']);
  const tool=inspection.tools[0]!;
  await store.decide(project.id,tool.toolId,{form:'SCRIPT',baseAssetId:source.assetId});
  expect(buildMigrationPlan(inspection,(await store.get(project.id)).decisions??[],source.assetId).generationAllowed).toBe(true);

  // A4: the migrated deliverable.
  const generated=await store.generate(project.id,{baseAssetId:source.assetId});
  const candidate=generated.candidate!;
  expect(candidate.assetId).not.toBe(source.assetId);
  expect(generated.inspection?.tools[0]?.kind).toBe('SCRIPT');

  // The chain's gate, in order. Each of these is the reason the next one cannot be skipped:
  const configuration={
    pair:'AB' as const,
    configuration:{
      packId:pack.packId,
      runtime:{type:'runtime_http' as const,environmentId:'env-openjiuwen'},
      executionModel:{providerId:'controlled',modelId:'fixture',parameters:{}},
      runtimeBindings:{left:{environmentId:'env-openjiuwen',skillAssetId:source.assetId},right:{environmentId:'env-openjiuwen',skillAssetId:candidate.assetId}},
      leftVariant:{mode:'skill_version' as const,skillId:source.skillId,version:source.version,artifactSha256:source.artifactSha256},
      rightVariant:{mode:'skill_version' as const,skillId:candidate.skillId,version:candidate.version,artifactSha256:candidate.artifactSha256},
    },
    dataSnapshot:'冻结的账户余额与币种数据',
    permissionBasis:'夹具：受控测试数据，不含真实客户信息',
    sourceProjectRef:'fixture-original-project',
    dependencyLockRef:'fixture-lock',
  };

  // No evaluation may be asked for before the current candidate's Tools are verified.
  await expect(store.validateOpenJiuwen(project.id,configuration)).rejects.toThrow('尚未通过当前资产的技术验证');

  // Technical validation runs the delivered Script for real, on this machine.
  const technical=await store.validateTechnical(project.id,{toolId:tool.toolId,baseAssetId:candidate.assetId,request:{value:7}});
  expect(technical.status).toBe('PASSED');

  // ... and only now does the target evaluation open.
  const experiment=await store.validateOpenJiuwen(project.id,configuration);
  expect(experiment.job.jobId).toBe('job-1');
  const afterEvaluation=await store.get(project.id);
  expect(afterEvaluation.runs.map(run=>run.jobId)).toEqual(['job-1']);
  expect((await store.report(project.id)).openJiuwenValidations).toHaveLength(1);

  // Optimization: the store's own preconditions on top of the optimizer's.
  const item=await store.optimize(project.id,{jobId:'job-1'});
  expect(item.optimizationId).toBe('opt-1');
  expect((await store.get(project.id)).optimizations).toEqual([
    {optimizationId:'opt-1',sourceJobId:'job-1',baseAssetId:candidate.assetId,candidateDigest:candidate.artifactSha256},
  ]);

  // The optimizer's product, adopted as the project's candidate.
  const optimized=await upload({
    'skill/SKILL.md':'---\nname: chain-lookup\ndescription: 端到端链路夹具，查询账户余额。\n---\n调用 `lookup`，传入 account_id；缺失信息时不要编造。\n成功时返回币种与账面余额。\n',
    'scripts/lookup.py':OPTIMIZED_LOOKUP_PY,
  });
  optimization={optimizationId:'opt-1',sourceJobId:'job-1',status:'review',candidate:optimized,summary:'补上缺失信息时的处理'};
  const adopted=await store.adoptOptimization(project.id,{optimizationId:'opt-1'});
  expect(adopted.candidate?.assetId).toBe(optimized.assetId);
  expect(adopted.candidateHistory?.at(-1)).toMatchObject({kind:'optimization'});

  // Adoption is a choice of candidate, not evidence about it: every artefact of the run before it
  // described *those* bytes. Nothing here may quietly keep applying to the new ones.
  const settled=await store.report(project.id);
  expect(settled.technicalValidations.map(validation=>({toolId:validation.toolId,current:validation.current})))
    .toEqual([{toolId:tool.toolId,current:false}]);
  expect(settled.openJiuwenValidations.map(validation=>validation.current)).toEqual([false]);
  expect(settled.verification.targetExecution).toBe('NOT_RUN');
  await expect(store.optimize(project.id,{jobId:'job-1'})).rejects.toThrow('请为当前候选选择一次运行记录');
  await expect(store.validateOpenJiuwen(project.id,configuration)).rejects.toThrow('尚未通过当前资产的技术验证');

  // And re-verifying the new candidate is what opens it again -- the evidence is replaced, not lost.
  await store.inspect(project.id);
  const revisedTool=(await store.get(project.id)).inspection!.tools[0]!;
  await store.decide(project.id,revisedTool.toolId,{form:'SCRIPT',baseAssetId:optimized.assetId});
  const reverified=await store.validateTechnical(project.id,{toolId:revisedTool.toolId,baseAssetId:optimized.assetId,request:{value:7}});
  expect(reverified.status).toBe('PASSED');
  const reverifiedReport=await store.report(project.id);
  // The old result is kept as history rather than erased; what changed is that it no longer
  // describes the candidate in hand.
  expect(reverifiedReport.technicalValidations.filter(validation=>validation.current).map(validation=>validation.status)).toEqual(['PASSED']);
  expect(reverifiedReport.technicalValidations.filter(validation=>!validation.current)).toHaveLength(1);
});
