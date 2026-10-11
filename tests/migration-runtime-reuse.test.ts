import {expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {runtimeLauncherCapabilitiesSchema} from '../src/shared/contracts/runtime-launcher.js';
import {canonicalSha256} from '../src/shared/json-canonicalization.js';
import {runtimeBuildRequirements} from '../src/migration/domain/migration-harness.js';
import {currentRuntimeReuse,runtimeReuseIssues,reusedCapabilitiesDigest} from '../src/migration/domain/migration-runtime-reuse.js';
import {MigrationPlanningService} from '../src/migration/application/migration-planning-service.js';
import {verifyRuntimeReuse} from '../src/migration/application/migration-environment-repository.js';
import {MigrationEvaluationService} from '../src/migration/application/migration-evaluation-service.js';
import type {MigrationProject} from '../src/migration/domain/migration-project.js';
import type {MigrationProjectStore} from '../src/migration/application/migration-project-store.js';
import {inspectionFixture} from './analysis-fixture.js';

function fixture(){
 const capability={capabilityId:'workspace.reader',name:'read_file',
  contract:{inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']},outputSchema:{type:'string'},errorSchema:{type:'object'},semantics:'Read a relative file in the isolated workspace'},
  constraints:{permissions:['workspace.read'],sideEffects:'read' as const,isolation:'per_case'}};
 const capabilities=runtimeLauncherCapabilitiesSchema.parse({schemaVersion:'finance.skill-eval.runtime-capabilities.v1',runtime:{type:'openjiuwen',version:'1'},models:[{modelId:'model',upstreamModelId:'real-model'}],defaultModelId:'model',
  nativeToolNames:['read_file'],nativeCapabilities:[capability],features:{streaming:true,asyncLaunch:true,packagedMcp:true,externalMcp:true,inlineSecrets:true},limits:{maxArchiveBytes:100,maxFiles:10,maxTimeoutMs:10000,maxConcurrentInstances:2}});
 const inspection=inspectionFixture([]);
 inspection.runtimeCapabilities=[{name:'source_read',owner:'RUNTIME_HARNESS',migrationAction:'REQUIRES_RUNTIME_BUILDER',blocking:true,reason:'Read with matching boundaries',usageContract:'relative path',targetCapability:capability.capabilityId,
  contract:capability.contract,constraints:capability.constraints,consumerTools:[],testAvailability:'UNCHECKED',evidence:[{path:'SKILL.md',line:1,kind:'SOURCE',detail:'Read the workspace document.'}]}];
 const requirements=runtimeBuildRequirements(inspection)!;
 if(!('requirementsDigest' in requirements))throw Error('fixture incomplete');
 const project={id:'migration-test',inspection,sourceInspection:inspection,candidate:null} as unknown as MigrationProject;
 const launcher={environmentId:'env-native',type:'runtime_launcher' as const,runtimeType:'openjiuwen' as const,baseUrl:'http://127.0.0.1:19001/',name:'Existing',credentialEnv:null,createdAt:'2026-10-08T00:00:00Z',updatedAt:'2026-10-08T00:00:00Z'};
 const environments={get:vi.fn(async(id:string)=>id===launcher.environmentId?launcher:null),preflight:vi.fn(async()=>({status:'ready',capabilities}))};
 const projects={get:async()=>project,save:vi.fn(),runExclusive:async(_id:string,action:()=>Promise<unknown>)=>action()} as unknown as MigrationProjectStore;
 const service=new MigrationPlanningService(projects,{serialize:()=>null},environments);
 return {capability,capabilities,inspection,requirements,project,launcher,environments,service,projects};
}

it('reuses an explicitly mapped existing contract without synthesizing a Builder delivery',async()=>{
 const f=fixture();expect(runtimeReuseIssues(f.requirements,f.capabilities)).toEqual([]);
 await f.service.reuseRuntime(f.project.id,{environmentId:f.launcher.environmentId});
 expect(f.project.runtimeDelivery).toBeUndefined();
 expect(currentRuntimeReuse(f.project)).toMatchObject({requirementsDigest:f.requirements.requirementsDigest,capabilitiesDigest:canonicalSha256(f.capabilities)});
 expect(reusedCapabilitiesDigest(f.project,{selected:f.launcher,launcher:f.launcher})).toBe(canonicalSha256(f.capabilities));
 expect(reusedCapabilitiesDigest(f.project,{selected:{environmentId:'another'},launcher:f.launcher})).toBeUndefined();
 expect(reusedCapabilitiesDigest(f.project,{selected:f.launcher,launcher:{...f.launcher,updatedAt:'changed'}})).toBeUndefined();
 await expect(verifyRuntimeReuse(f.project,f.environments,f.launcher.environmentId)).resolves.toBeUndefined();
 // The source dependency is retained, not deleted to get a green workflow.
 expect((await f.service.runtimeRequirements(f.project.id))).toEqual(f.requirements);
});

it.each(['name-only','input','error','permission','isolation','runtime'] as const)('does not infer compatibility from a familiar tool name: %s',async change=>{
 const f=fixture(),c=f.capabilities.nativeCapabilities![0]!;
 if(change==='name-only')delete f.capabilities.nativeCapabilities;
 if(change==='input')c.contract.inputSchema={type:'string'};
 if(change==='error')c.contract.errorSchema={type:'null'};
 if(change==='permission')c.constraints.permissions.push('host.read');
 if(change==='isolation')c.constraints.isolation='shared';
 if(change==='runtime')f.capabilities.runtime.type='other';
 expect(runtimeReuseIssues(f.requirements,f.capabilities).length).toBeGreaterThan(0);
 await expect(f.service.reuseRuntime(f.project.id,{environmentId:f.launcher.environmentId})).rejects.toThrow('不能确认');
 expect(f.project.runtimeReuse).toBeUndefined();
});

it('invalidates reuse on requirement, live inventory, registry or selected-environment drift',async()=>{
 const f=fixture();await f.service.reuseRuntime(f.project.id,{environmentId:f.launcher.environmentId});
 await expect(verifyRuntimeReuse(f.project,f.environments,'another')).rejects.toThrow('重新检查');
 f.capabilities.runtime.version='2';
 await expect(verifyRuntimeReuse(f.project,f.environments,f.launcher.environmentId)).rejects.toThrow('已变化');
 f.capabilities.runtime.version='1';f.launcher.updatedAt='2026-10-08T00:01:00Z';
 await expect(verifyRuntimeReuse(f.project,f.environments,f.launcher.environmentId)).rejects.toThrow('已变化');
 f.inspection.runtimeCapabilities![0]!.reason='New source requirement';
 expect(currentRuntimeReuse(f.project)).toBeNull();
 await expect(verifyRuntimeReuse(f.project,f.environments,f.launcher.environmentId)).rejects.toThrow('需求已变化');
});

it('does not use reuse to bypass incomplete requirements or an explicit rebuild',async()=>{
 const f=fixture();
 expect(runtimeReuseIssues({...f.requirements,rebuild:{baseline:{deploymentId:'old',artifactSha256:'a'.repeat(64),solutionRevisionId:'b'.repeat(64)},hypothesis:{id:'fix',issue:'capacity',expectedBehavior:'higher capacity'},evidence:[{jobId:'failed',summary:'iteration budget'}]}},f.capabilities)).toEqual(['REBUILD_REQUIRED']);
 delete f.inspection.runtimeCapabilities![0]!.contract;
 await expect(f.service.reuseRuntime(f.project.id,{environmentId:f.launcher.environmentId})).rejects.toThrow('完善能力诊断');
});

it('independently guards an admitted alternate deployment against live capability drift',async()=>{
 const f=fixture();await f.service.reuseRuntime(f.project.id,{environmentId:f.launcher.environmentId});
 const delivery={schemaVersion:'finance.runtime-launcher-delivery-record.v1' as const,buildId:'build',requestId:f.requirements.requestId,
  requirementsDigest:f.requirements.requirementsDigest,deploymentId:'deployment-other',artifactSha256:'d'.repeat(64),
  capabilitiesDigest:canonicalSha256(f.capabilities),resultDigest:'e'.repeat(64),builder:{name:'builder',version:'1'},
  acceptedAt:new Date().toISOString(),expiresAt:null,evalConformance:{status:'PASSED' as const,testedAt:new Date().toISOString(),
   checks:['capabilities','create','status','execute','evidence','delete'] as ['capabilities','create','status','execute','evidence','delete']}};
 const other={...f.launcher,environmentId:'other',delivery};
 f.project.runtimeDeliveries={other:{...delivery,environmentId:'other'}};
 f.environments.get.mockImplementation(async id=>id==='other'?other:id===f.launcher.environmentId?f.launcher:null);
 await expect(verifyRuntimeReuse(f.project,f.environments,'other')).resolves.toBeUndefined();
 f.capabilities.nativeCapabilities![0]!.constraints.isolation='shared';
 await expect(verifyRuntimeReuse(f.project,f.environments,'other')).rejects.toThrow('独立准入');
});

it('rejects unknown environments, failed discovery and mutating an active task binding',async()=>{
 const f=fixture();
 await expect(f.service.reuseRuntime(f.project.id,{environmentId:'unregistered'})).rejects.toThrow('已登记');
 f.environments.preflight.mockResolvedValueOnce({status:'failed',capabilities:f.capabilities});
 await expect(f.service.reuseRuntime(f.project.id,{environmentId:f.launcher.environmentId})).rejects.toThrow('无法读取');
 f.project.improvementTasks=[{status:'RUNNING'} as never];
 await expect(f.service.reuseRuntime(f.project.id,{environmentId:f.launcher.environmentId})).rejects.toThrow('改进任务');
});

it('keeps old capabilities valid but rejects ambiguous or unadvertised contracts',()=>{
 const f=fixture(),legacy={...f.capabilities};delete legacy.nativeCapabilities;
 expect(runtimeLauncherCapabilitiesSchema.safeParse(legacy).success).toBe(true);
 expect(runtimeLauncherCapabilitiesSchema.safeParse({...f.capabilities,nativeToolNames:[]}).success).toBe(false);
 expect(runtimeLauncherCapabilitiesSchema.safeParse({...f.capabilities,nativeCapabilities:[f.capability,f.capability]}).success).toBe(false);
 const published=JSON.parse(readFileSync('contracts/runtime-launcher/finance.skill-eval.runtime-capabilities.v1.schema.json','utf8'));
 expect(published.properties.nativeCapabilities.items.required).toEqual(['capabilityId','name','contract','constraints']);
});

it('guards the generic evaluation entry point, not only the OpenJiuwen convenience route',async()=>{
 const f=fixture(),create=vi.fn();f.project.candidate={assetId:'candidate'} as never;
 const evaluation=new MigrationEvaluationService(f.projects,{create} as never,{get:()=>null} as never,undefined,undefined,undefined,undefined,f.environments);
 const plan={pair:'BC',dataSnapshot:'synthetic',permissionBasis:'test',sourceProjectRef:'test',dependencyLockRef:'test',configuration:{
  packId:'missing-suite',leftVariant:{mode:'skill_version',skillId:'fixture',version:'1',artifactSha256:'a'.repeat(64)},rightVariant:{mode:'skill_version',skillId:'fixture',version:'1',artifactSha256:'a'.repeat(64)},
  runtime:{type:'runtime_launcher',environmentId:f.launcher.environmentId},executionModel:{providerId:'test',modelId:'model',parameters:{}},judgeMode:'model',evaluationMode:'candidate_assessment',
  runtimeBindings:{left:{environmentId:f.launcher.environmentId,skillAssetId:'candidate'},right:{environmentId:f.launcher.environmentId,skillAssetId:'candidate'}}}};
 await expect(evaluation.validate(f.project.id,plan)).rejects.toThrow('Runtime 能力尚未确认');
 await f.service.reuseRuntime(f.project.id,{environmentId:f.launcher.environmentId});
 // Reuse clears only the capability gate; independent suite requirements remain enforced.
 await expect(evaluation.validate(f.project.id,plan)).rejects.toThrow('冻结的开发题集');
 f.capabilities.runtime.version='changed';
 await expect(evaluation.validate(f.project.id,plan)).rejects.toThrow('Runtime 能力或连接已变化');
 expect(create).not.toHaveBeenCalled();
});
