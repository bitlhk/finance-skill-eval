import {expect,it} from 'vitest';
import {MigrationOptimizationService} from '../src/migration/application/migration-optimization-service.js';
import type {MigrationProject} from '../src/migration/domain/migration-project.js';

it('links a Skill optimization to a matching evidence plan and rejects a different layer',async()=>{
  const digest='a'.repeat(64),asset={assetId:'candidate',artifactSha256:digest};
  const project={id:'migration-1234',candidate:asset,runs:[{jobId:'job-1',candidateDigest:digest,
    declaredPlan:{configuration:{runtime:{type:'runtime_launcher',environmentId:'env-1'}}}}],
    improvementPlans:[{planId:'plan-1',sourceJobId:'job-1',candidateDigest:digest,hypothesis:{layer:'TOOL'}}]} as unknown as MigrationProject;
  const projects={runExclusive:async(_id:string,action:()=>Promise<unknown>)=>action(),get:async()=>project,save:async()=>undefined};
  const service=new MigrationOptimizationService(projects as any,{} as any,
    {get:()=>({report:{variants:{right:{mode:'skill_version',artifactSha256:digest}}}})} as any,
    {currentState:async()=>({ready:true,reasons:[]})} as any,
    {create:async()=>({optimizationId:'opt-1'})} as any,
    {get:async()=>({environmentId:'env-1',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:'https://example.test/'})} as any,
    {get:async()=>({values:{}})} as any);
  await expect(service.optimize(project.id,{jobId:'job-1',planId:'plan-1'})).rejects.toThrow('规划');
  project.improvementPlans![0]!.hypothesis!.layer='SKILL';
  const result=await service.optimize(project.id,{jobId:'job-1',planId:'plan-1'});
  expect(result.optimizationId).toBe('opt-1');
  expect(project.optimizations?.[0]?.planId).toBe('plan-1');
});
