import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { MigrationStore } from '../src/migration/migration-store.js';
import { SkillStore } from '../src/service/skill-store.js';
import { EvalPackCatalog } from '../src/service/catalog.js';
import type { EvaluationRunManager } from '../src/service/run-manager.js';
import type { EvaluationJobStore } from '../src/service/job-store.js';

it('checks pair bindings before scheduling and retains declared conditions and suite snapshots',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'migration-plan-'));
  try {
    const skills=new SkillStore(dir);await skills.initialize();
    const asset=async(version:string)=>skills.uploadZip(Buffer.from(zipSync({'SKILL.md':strToU8(`---\nname: synthetic\nversion: ${version}\n---\nRead only`)})));
    const a=await asset('1.0.0'),b=await asset('1.0.1');
    const catalog=new EvalPackCatalog(path.resolve('.'));await catalog.initialize();
    const create=vi.fn(async()=>({jobId:'synthetic-job'}));
    const jobs={get:()=>({status:'queued'})} as unknown as EvaluationJobStore;
    const migrations=new MigrationStore(dir,{skills,runs:{create} as unknown as EvaluationRunManager,jobs,catalog});
    const project=await migrations.create({name:'Synthetic',sourceAssetId:a.assetId});
    await migrations.candidate(project.id,{assetId:b.assetId,notes:'Synthetic method change'});
    const variant=(item:typeof a)=>({mode:'skill_version',skillId:item.skillId,version:item.version,artifactSha256:item.artifactSha256});
    const plan={pair:'AB',dataSnapshot:'fixture-v1',permissionBasis:'synthetic-only',sourceProjectRef:'fixture-project',dependencyLockRef:'fixture-lock',
      configuration:{packId:catalog.list()[0]!.packId,runtime:{type:'runtime_launcher',environmentId:'original'},executionModel:{providerId:'fixture',modelId:'same'},
        leftVariant:variant(a),rightVariant:variant(b),runtimeBindings:{left:{environmentId:'original',skillAssetId:a.assetId},right:{environmentId:'other',skillAssetId:b.assetId}}}};
    const unmanaged={...plan,configuration:{...plan.configuration,runtime:{type:'direct_model' as const}}};
    await expect(migrations.validate(project.id,unmanaged)).rejects.toThrow('Runtime Launcher');expect(create).not.toHaveBeenCalled();
    await expect(migrations.validate(project.id,plan)).rejects.toThrow('左右执行绑定');expect(create).not.toHaveBeenCalled();
    plan.configuration.runtimeBindings.right.environmentId='original';
    await migrations.validate(project.id,plan);expect(create).toHaveBeenCalledOnce();
    const saved=await migrations.get(project.id),run=saved.runs[0]!;
    expect(run.declaredPlan?.dataSnapshot).toBe('fixture-v1');
    expect(run.suiteSnapshot?.packFingerprint).toBe(run.packFingerprint);
    expect(saved.assessment).toBe('NOT_VALIDATED');
    expect((await migrations.report(project.id)).experiments[0]!.evidence).toBe('NOT_COMPLETE');
    await expect(migrations.validate(project.id,{...plan,pair:'BC'})).rejects.toThrow('绑定');
    expect(create).toHaveBeenCalledOnce();
    const wholeSolution={...plan,pair:'AC',configuration:{...plan.configuration,evaluationMode:'solution_comparison',runtime:{type:'runtime_launcher',environmentId:'other'},
      runtimeBindings:{left:{environmentId:'original',skillAssetId:a.assetId},right:{environmentId:'other',skillAssetId:b.assetId}},
      leftExecutionModel:{providerId:'original-provider',modelId:'old-model'},rightExecutionModel:{providerId:'other-provider',modelId:'new-model'}}};
    await migrations.validate(project.id,wholeSolution);
    expect(create).toHaveBeenCalledTimes(2);
    expect((await migrations.report(project.id)).experiments.at(-1)?.comparisonKind).toBe('WHOLE_SOLUTION');
    expect((await migrations.report(project.id)).verification.targetExecution).toBe('NOT_RUN');
  } finally {await rm(dir,{recursive:true,force:true});}
});
