import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { EnvironmentStore } from '../src/service/environment-store.js';
import { createMigrationTaskService } from '../src/migration/tasks/composition.js';
import { registerMigrationTaskRoutes } from '../src/interfaces/http/migration-task-routes.js';
import { bundleZip, type BundleTask } from '../src/migration/tasks/domain/task-model.js';
import { canonicalSha256 } from '../src/shared/json-canonicalization.js';
import { withResultDigest } from '../src/shared/contracts/runtime-builder.js';
// @ts-expect-error Shared JavaScript fixture is also used by Playwright.
import { taskBuilderLauncher, taskBuilderResult } from '../scripts/lib/task-builder-test-launcher.mjs';

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { while(cleanups.length) await cleanups.pop()!(); });
async function setup(count=3) {
  const root = await mkdtemp(path.join(os.tmpdir(),'task-builder-')); cleanups.push(()=>rm(root,{recursive:true,force:true}));
  const host = await taskBuilderLauncher(); cleanups.push(()=>host.app.close());
  const environments = new EnvironmentStore(root,[{reference:'builder-local',label:'Local',baseUrlPrefix:host.baseUrl,credentialEnv:null}]); await environments.initialize();
  const logs: Record<string,unknown>[]=[];
  const options = { root, environments, skills:{get:async()=>null,readArchive:async()=>({})}, logger:{info:(x:Record<string,unknown>)=>logs.push(x),warn:(x:Record<string,unknown>)=>logs.push(x),error:(x:Record<string,unknown>)=>logs.push(x)},
    ports:{agent:async(input:any)=> input.mode==='ANALYZE' ? {status:'PRODUCED' as const,analysis:{summary:'Analyze members',changes:[],missing:[]}}
      : {status:'PRODUCED' as const,files:input.base.files,delivery:{summary:'Candidate',services:[]}},judge:async()=>({passed:true,reason:'Fixture business assertion'})} };
  const service=createMigrationTaskService(options); cleanups.push(()=>service.close());
  await service.initialize();
  const files = Object.fromEntries(Array.from({length:count},(_,i)=>[`skills/s${i}/SKILL.md`,Buffer.from(`---\nname: s${i}\ndescription: skill ${i}\n---\nBusiness instructions`).toString('base64')]));
  let task=await service.upload({name:'Builder task',goal:'Business',target:'OpenJiuwen'},bundleZip(files));
  async function finish(kind:'ANALYZE'|'GENERATE'|'ACCEPT', extra={}){
    task=await service.get(task.id);
    await service.start(task.id,kind,{key:randomUUID(),baseCandidateId:task.currentCandidateId,...extra});
    for(let i=0;i<200;i++) { task=await service.get(task.id); if(!task.attempts.some(a=>a.status==='RUNNING')) return task; await new Promise(r=>setTimeout(r,10)); }
    throw new Error('Operation timed out');
  }
  await finish('ANALYZE');await finish('GENERATE');
  const app=Fastify();registerMigrationTaskRoutes(app,service,true);cleanups.push(()=>app.close());
  const url='/api/migration-tasks/'+task.id;
  async function request(overrides:Record<string,unknown>={}){
    task=await service.get(task.id);
    const response=await app.inject({method:'POST',url:url+'/runtime-build-requests',payload:{baseCandidateId:task.currentCandidateId,runtimeType:'openjiuwen',timeoutMs:10000,harnessTools:[],...overrides}});
    expect(response.statusCode,response.body).toBe(200);
    task=response.json();return service.builder!.requirements(task.id);
  }
  const accept=(result:unknown,trustReference='builder-local')=>app.inject({method:'POST',url:url+'/runtime-deliveries',payload:{result,trustReference},headers:{'x-request-id':'builder-http-request'}});
  return {root,options,host,environments,service,app,url,id:task.id,request,accept,finish,logs};
}

it.each([1,3])('binds %i members through v2 lifecycle, persists, accepts and exports the exact Builder revision',async count=>{
  const f=await setup(count),req=await f.request();
  expect((req.extensions!.migrationTask as any).members).toHaveLength(count);
  const yaml=await f.app.inject(f.url+'/runtime-requirements.yaml');expect(yaml.statusCode).toBe(200);expect(yaml.body).toContain('finance.skill-eval.runtime-instance.v2');
  const source=await f.app.inject(f.url+'/runtime-build-requests/'+req.requestId+'/source.zip');expect(Object.keys(unzipSync(source.rawPayload))).toHaveLength(count);
  const result=taskBuilderResult(req,f.host,withResultDigest,canonicalSha256);
  const first=await f.accept(result);expect(first.statusCode,first.body).toBe(200);
  const bound=first.json() as BundleTask;expect(bound.builderStatus).toBe('BOUND');expect(bound.runtimeDeliveries).toHaveLength(1);
  expect(f.host.lifecycle).toEqual(['create','status','execute','delete']);expect(f.host.creations[0].schemaVersion).toBe('finance.skill-eval.runtime-instance.v2');expect(f.host.creations[0].bundle.members).toHaveLength(count);expect(f.host.instances.size).toBe(0);
  const repeated=await f.accept(result);expect(repeated.statusCode,repeated.body).toBe(200);expect(repeated.json().runtimeDelivery.id).toBe(bound.runtimeDelivery!.id);expect(repeated.json().runtimeDeliveries).toHaveLength(1);
  await f.service.saveSuite(f.id,{name:'Suite',cases:[{id:'dev',input:'Run business task',criteria:['BUSINESS_OK']}],holdoutCases:[{id:'held',input:'Independent task',criteria:['BUSINESS_OK']}]});
  await f.finish('ACCEPT');await expect(f.service.export(f.id,true)).rejects.toThrow(/尚未通过/);
  const accepted=await f.finish('ACCEPT',{phase:'holdout'});expect(accepted.runs.at(-1)?.status).toBe('PASSED');expect(accepted.runs.at(-1)?.builderBindingId).toBe(bound.runtimeDelivery!.id);
  const pack=unzipSync(await f.service.export(f.id,true));expect(pack['migration/runtime-build-result.json']).toBeDefined();expect(JSON.parse(Buffer.from(pack['migration/manifest.json']!).toString()).builderBinding.id).toBe(bound.runtimeDelivery!.id);
  const restarted=createMigrationTaskService(f.options);await restarted.initialize();expect((await restarted.get(f.id)).runtimeDelivery).toEqual(bound.runtimeDelivery);await restarted.close();
  expect(f.logs.some(x=>x.event==='migration_builder_delivery_bound'&&x.buildRequestId===req.requestId)).toBe(true);
  f.host.caps.runtime.version='changed';await expect(f.service.checkRuntime(f.id)).rejects.toThrow(/环境已变化/);await expect(f.service.export(f.id,true)).rejects.toThrow(/环境已变化/);
});

it.each(['trust','digest','members','cleanup','v1','receipt','model','partial'])('rejects %s without binding or registering an unverified environment',async mode=>{
  const f=await setup();const req=await f.request();
  if(mode==='v1')f.host.caps.features.multiSkill=false;
  if(mode==='members')f.host.control.badMembers=true;
  if(mode==='cleanup')f.host.control.cleanupFailure=true;
  let result=taskBuilderResult(req,f.host,withResultDigest,canonicalSha256);
  if(mode==='digest')result.requirementsDigest='a'.repeat(64);
  if(mode==='receipt'){delete result.extensions;const {resultDigest,...body}=result;result=withResultDigest(body);}
  if(mode==='partial'){const {resultDigest,...body}=result;result=withResultDigest({...body,status:'PARTIAL',launcher:null});}
  if(mode==='model') { f.host.caps.models=[{modelId:'other',upstreamModelId:'fixture'}]; f.host.caps.defaultModelId='other'; }
  const response=await f.accept(result,mode==='trust'?'untrusted':'builder-local');expect(response.statusCode,response.body).toBe(400);
  expect((await f.service.get(f.id)).runtimeDelivery).toBeUndefined();expect(await f.environments.list()).toHaveLength(0);
  if(['members','cleanup'].includes(mode))expect(f.host.lifecycle.at(-1)).toBe('delete');
});

it('invalidates changed candidates, configurations and superseded requests, preserving history',async()=>{
  const f=await setup(1),req=await f.request(),result=taskBuilderResult(req,f.host,withResultDigest,canonicalSha256);
  expect((await f.accept(result)).statusCode).toBe(200);
  const bound=await f.service.get(f.id);await f.service.configure(f.id,{...bound.configuration,timeoutMs:11000});
  expect((await f.service.get(f.id)).builderStatus).toBe('STALE');expect((await f.accept(result)).statusCode).toBe(409);
  const stalePack=unzipSync(await f.service.export(f.id));const staleManifest=JSON.parse(Buffer.from(stalePack['migration/manifest.json']!).toString());
  expect(staleManifest.builderStatus).toBe('STALE');expect(staleManifest.builderBinding).toBeUndefined();expect(staleManifest.verified).toBe(false);
  await expect(f.service.start(f.id,'ACCEPT',{key:randomUUID(),baseCandidateId:bound.currentCandidateId})).rejects.toThrow(/Builder/);
  const req2=await f.request();expect((await f.accept(result)).statusCode).toBe(409);
  const result2=taskBuilderResult(req2,f.host,withResultDigest,canonicalSha256,'2');await f.finish('GENERATE');expect((await f.accept(result2)).statusCode).toBe(409);
  expect((await f.service.get(f.id)).runtimeDeliveries).toHaveLength(1);
  const oldZip=await f.app.inject(f.url+'/runtime-build-requests/'+req.requestId+'/source.zip');expect(oldZip.statusCode).toBe(200);
  const switched=await f.app.inject({method:'DELETE',url:f.url+'/runtime-builder-selection'});expect(switched.statusCode).toBe(200);expect(switched.json().selectedRuntimeBuildRequestId).toBeUndefined();expect(switched.json().runtimeDeliveries).toHaveLength(1);
});

it('does not accept another task receipt and never exports holdout cases in requirements',async()=>{
  const f=await setup();await f.service.saveSuite(f.id,{name:'hidden',cases:[{id:'dev',input:'DEVELOPMENT_SECRET',criteria:['dev']}],holdoutCases:[{id:'hidden',input:'HOLDOUT_SECRET',criteria:['secret']}]});
  const req=await f.request();expect(JSON.stringify(req)).not.toMatch(/HOLDOUT_SECRET|DEVELOPMENT_SECRET/);
  const original=taskBuilderResult(req,f.host,withResultDigest,canonicalSha256);const {resultDigest,...body}=original;
  const foreign=withResultDigest({...body,extensions:{migrationTask:{...body.extensions.migrationTask,taskId:'bundle-another'}}});
  expect((await f.accept(foreign)).statusCode).toBe(400);expect(f.host.creations).toHaveLength(0);
});

it('serializes duplicate deliveries and a concurrent configuration change',async()=>{
  const f=await setup(),req=await f.request(),result=taskBuilderResult(req,f.host,withResultDigest,canonicalSha256);
  let release!:()=>void;f.host.control.executeGate=new Promise<void>(resolve=>{release=resolve;});
  const accepting=f.accept(result);await expect.poll(()=>f.host.lifecycle.includes('execute')).toBe(true);
  const configuring=f.service.configure(f.id,{environmentId:'another-environment',modelId:'execution',timeoutMs:10000,harnessTools:[]});
  release();expect((await accepting).statusCode).toBe(200);await configuring;
  expect((await f.service.get(f.id)).builderStatus).toBe('STALE');expect((await f.service.get(f.id)).runtimeDeliveries).toHaveLength(1);
  f.host.control.executeGate=null;
  const next=await f.request(),nextResult=taskBuilderResult(next,f.host,withResultDigest,canonicalSha256,'next');
  const responses=await Promise.all([f.accept(nextResult),f.accept(nextResult)]);expect(responses.map(r=>r.statusCode)).toEqual([200,200]);
  expect(responses[0]!.json().runtimeDelivery.id).toBe(responses[1]!.json().runtimeDelivery.id);
  expect((await f.service.get(f.id)).runtimeDeliveries).toHaveLength(2);
});

it('recovers after registry admission succeeds but the task write fails, without false success logs',async()=>{
  const f=await setup(),req=await f.request(),result=taskBuilderResult(req,f.host,withResultDigest,canonicalSha256);
  const repository=(f.service.builder as any).repository, original=repository.update.bind(repository);
  repository.update=(id:string,change:(t:BundleTask)=>Promise<void>)=>original(id,async(t:BundleTask)=>{await change(t);throw new Error('SIMULATED_DISK_WRITE_FAILURE');});
  const failed=await f.accept(result);expect(failed.statusCode).toBe(500);expect((await f.service.get(f.id)).runtimeDelivery).toBeUndefined();expect(await f.environments.list()).toHaveLength(1);
  expect(f.logs.some(l=>l.event==='migration_builder_delivery_bound')).toBe(false);
  repository.update=original;
  const retried=await f.accept(result);expect(retried.statusCode,retried.body).toBe(200);expect(await f.environments.list()).toHaveLength(1);expect(retried.json().runtimeDeliveries).toHaveLength(1);
});

it('requires fresh acceptance after explicitly switching from Builder to an existing environment',async()=>{
  const f=await setup(1),req=await f.request();expect((await f.accept(taskBuilderResult(req,f.host,withResultDigest,canonicalSha256))).statusCode).toBe(200);
  await f.service.saveSuite(f.id,{name:'Suite',cases:[{id:'dev',input:'Task',criteria:['BUSINESS_OK']}]});await f.finish('ACCEPT');await f.service.export(f.id,true);
  await f.service.builder!.useExisting(f.id);await expect(f.service.export(f.id,true)).rejects.toThrow(/尚未通过/);
  await f.finish('ACCEPT');await expect(f.service.export(f.id,true)).resolves.toBeInstanceOf(Buffer);
});

it('checks required native contracts against the actual Launcher declaration',async()=>{
  const f=await setup();const requirement={id:'read-document',name:'read_document',required:true,reason:'read business files',contract:{inputSchema:{type:'object'},outputSchema:{type:'object'},errorSchema:{type:'object'},semantics:'read only within instance'},constraints:{permissions:['workspace.read'],sideEffects:'read' as const,isolation:'per_instance'},preferredTargetCapability:null,consumerTools:['review'],evidence:[{path:'skills/s0/SKILL.md',line:4,detail:'read documents'}]};
  const req=await f.request({requiredCapabilities:[requirement]});
  const original=taskBuilderResult(req,f.host,withResultDigest,canonicalSha256),{resultDigest,...body}=original;
  const delivered={...body,capabilityResults:[{requirementId:requirement.id,status:'IMPLEMENTED' as const,capabilityId:'file.read',contractDigest:canonicalSha256(requirement.contract),verificationIds:['native-test']}],verifications:[{id:'native-test',type:'CONTRACT_TEST',status:'PASSED' as const}]};
  expect((await f.accept(withResultDigest(delivered))).statusCode).toBe(400);expect(f.host.creations).toHaveLength(0);
  f.host.caps.nativeToolNames=['read_document'];f.host.caps.nativeCapabilities=[{capabilityId:'file.read',name:'read_document',contract:requirement.contract,constraints:requirement.constraints}];
  const accepted=await f.accept(withResultDigest({...delivered,launcher:{...delivered.launcher,capabilitiesDigest:canonicalSha256(f.host.caps)}}));expect(accepted.statusCode,accepted.body).toBe(200);
});

it('rejects expired or credential-bearing delivery before any lifecycle call',async()=>{
  const f=await setup(),req=await f.request(),original=taskBuilderResult(req,f.host,withResultDigest,canonicalSha256),{resultDigest,...body}=original;
  const expired=withResultDigest({...body,launcher:{...body.launcher,expiresAt:'2020-01-01T00:00:00.000Z'}});expect((await f.accept(expired)).statusCode).toBe(400);
  const secret=withResultDigest({...body,extensions:{...body.extensions,apiKey:'should-never-be-delivered'}});expect((await f.accept(secret)).statusCode).toBe(409);
  expect(f.host.creations).toHaveLength(0);
});
