import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {EnvironmentStore} from '../src/service/environment-store.js';
import {environmentArchiveSchema, environmentListQuerySchema, environmentRecordSchema} from '../src/shared/contracts/environment.js';
import {createEvaluationService} from '../src/service/server.js';

const directories:string[]=[];
afterEach(async()=>{
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));
});
async function fixture(){
  const directory=await mkdtemp(path.join(tmpdir(),'eval-environment-archive-'));
  directories.push(directory);
  const store=new EnvironmentStore(directory);
  await store.initialize();
  return {store,directory};
}
const launcherInput={name:'Acceptance is just a name',type:'runtime_launcher',runtimeType:'agentscope',baseUrl:'http://127.0.0.1:9000/'};
const mcpInput={name:'Ordinary service',type:'mcp_streamable_http',endpoint:'http://127.0.0.1:9001/mcp'};
const archivedError={statusCode:409,code:'ENVIRONMENT_ARCHIVED'};

it('defaults legacy metadata to active without rewriting original bytes',async()=>{
  const {store,directory}=await fixture();
  const current=await store.create(launcherInput);
  const {archived:_,...legacy}=current;
  const file=path.join(directory,'environments',`${current.environmentId}.json`);
  const bytes=JSON.stringify(legacy);
  await writeFile(file,bytes);
  expect(environmentRecordSchema.parse(legacy).archived).toBe(false);
  expect((await store.get(current.environmentId))?.archived).toBe(false);
  expect(await store.list()).toHaveLength(1);
  expect(await readFile(file,'utf8')).toBe(bytes);
});

it('archives and restores metadata without interpreting names or erasing references',async()=>{
  const {store,directory}=await fixture();
  const acceptance=await store.create(launcherInput);
  const ordinary=await store.create(mcpInput);
  const history=path.join(directory,'retained-run.json');
  const historyBytes=JSON.stringify({jobId:'run-historical',runtime:{environmentId:ordinary.environmentId},status:'completed'});
  await writeFile(history,historyBytes);
  const archived=await store.setArchived(ordinary.environmentId,{archived:true});
  expect(archived).toEqual({...ordinary,archived:true,updatedAt:archived.updatedAt});
  expect((await store.list()).map(item=>item.environmentId)).toEqual([acceptance.environmentId]);
  expect(await store.list({includeArchived:true})).toHaveLength(2);
  expect(await store.get(ordinary.environmentId)).toEqual(archived);
  const file=path.join(directory,'environments',`${ordinary.environmentId}.json`);
  const once=await readFile(file,'utf8');
  expect(await store.setArchived(ordinary.environmentId,{archived:true})).toEqual(archived);
  expect(await readFile(file,'utf8')).toBe(once);
  const restored=await store.setArchived(ordinary.environmentId,{archived:false});
  expect(restored).toEqual({...ordinary,updatedAt:restored.updatedAt});
  expect(await store.list()).toHaveLength(2);
  expect(await readFile(history,'utf8')).toBe(historyBytes);
});

it.each(['runtime_launcher','mcp_streamable_http','execution_environment'] as const)(
  'rejects archived %s and stale active snapshots before any transport',async type=>{
    const {store}=await fixture();
    const launcher=await store.create(launcherInput);
    const record=type==='runtime_launcher'?launcher:type==='mcp_streamable_http'?await store.create(mcpInput):
      await store.create({name:'Execution',type,launcherEnvironmentId:launcher.environmentId});
    const transport=vi.fn(()=>{throw Error('Network must not be used');});
    vi.stubGlobal('fetch',transport);
    await store.setArchived(record.environmentId,{archived:true});
    await expect(store.requireAvailable(record.environmentId)).rejects.toMatchObject(archivedError);
    await expect(store.preflight(record)).rejects.toMatchObject(archivedError);
    await expect(store.inspect(record)).rejects.toMatchObject(archivedError);
    await expect(store.resolveLauncher(record)).rejects.toMatchObject(archivedError);
    if(type==='runtime_launcher')await expect(store.nativeToolCatalog(record.environmentId)).rejects.toMatchObject(archivedError);
    expect(transport).not.toHaveBeenCalled();
    expect(await store.get(record.environmentId)).toMatchObject({archived:true});
  });

it.each(['launcher','mcp'] as const)('an archived %s dependency blocks new use, not historical reads',async target=>{
  const {store}=await fixture();
  const launcher=await store.create(launcherInput);
  const mcp=await store.create(mcpInput);
  const input={name:'Execution',type:'execution_environment',launcherEnvironmentId:launcher.environmentId,mcpEnvironmentIds:[mcp.environmentId]};
  const execution=await store.create(input);
  const dependency=target==='launcher'?launcher:mcp;
  await store.setArchived(dependency.environmentId,{archived:true});
  await expect(store.requireAvailable(execution.environmentId)).rejects.toMatchObject(archivedError);
  await expect(store.resolveLauncher(execution)).rejects.toMatchObject(archivedError);
  await expect(store.create(input)).rejects.toMatchObject(archivedError);
  await expect(store.update(execution.environmentId,input)).rejects.toMatchObject(archivedError);
  expect(await store.get(execution.environmentId)).toMatchObject({archived:false});
  await store.setArchived(dependency.environmentId,{archived:false});
  expect((await store.requireAvailable(execution.environmentId)).environmentId).toBe(execution.environmentId);
});

it('keeps archived dependents in deletion protection and normal edits do not restore',async()=>{
  const {store}=await fixture();
  const launcher=await store.create(launcherInput);
  const mcp=await store.create(mcpInput);
  const input={name:'Execution',type:'execution_environment',launcherEnvironmentId:launcher.environmentId,mcpEnvironmentIds:[mcp.environmentId]};
  const execution=await store.create(input);
  await store.setArchived(execution.environmentId,{archived:true});
  await expect(store.remove(launcher.environmentId)).rejects.toMatchObject({statusCode:409});
  await expect(store.remove(mcp.environmentId)).rejects.toMatchObject({statusCode:409});
  expect(await store.update(execution.environmentId,{...input,name:'Renamed'})).toMatchObject({archived:true});
});

it('serializes archive and normal edits without losing either change',async()=>{
  const {store}=await fixture();
  const launcher=await store.create(launcherInput);
  await Promise.all([
    store.setArchived(launcher.environmentId,{archived:true}),
    store.update(launcher.environmentId,{...launcherInput,name:'Updated'}),
  ]);
  expect(await store.get(launcher.environmentId)).toMatchObject({archived:true,name:'Updated'});
});

it.each([{}, {archived:'true'}, {archived:null}, {archived:true,name:'Mutated'}, {archived:1}])(
  'rejects invalid archive input %j',async input=>{
    const {store}=await fixture();
    const record=await store.create(launcherInput);
    expect(environmentArchiveSchema.safeParse(input).success).toBe(false);
    await expect(store.setArchived(record.environmentId,input)).rejects.toThrow();
    expect(await store.get(record.environmentId)).toEqual(record);
  });

it('does not coerce arbitrary listing query values or accept extra filters',()=>{
  expect(environmentListQuerySchema.parse({})).toEqual({includeArchived:false});
  expect(environmentListQuerySchema.parse({includeArchived:'false'})).toEqual({includeArchived:false});
  expect(environmentListQuerySchema.parse({includeArchived:'true'})).toEqual({includeArchived:true});
  for(const input of [{includeArchived:'1'},{includeArchived:true},{name:'Acceptance'}]){
    expect(environmentListQuerySchema.safeParse(input).success).toBe(false);
  }
});

it('does not recreate or revive an archived Builder deployment and sends no conformance request',async()=>{
  const {store,directory}=await fixture();
  const root=new URL('../contracts/runtime-builder/examples/',import.meta.url);
  const requirements=JSON.parse(await readFile(new URL('requirements.success.json',root),'utf8'));
  const result=JSON.parse(await readFile(new URL('result.success.json',root),'utf8'));
  const record=await store.create(launcherInput);
  const now=new Date().toISOString();
  const original=environmentRecordSchema.parse({...record,archived:true,delivery:{
    schemaVersion:'finance.runtime-launcher-delivery-record.v1',buildId:result.buildId,requestId:result.requestId,
    deploymentId:result.launcher.deploymentId,artifactSha256:result.launcher.artifactSha256,
    capabilitiesDigest:result.launcher.capabilitiesDigest,resultDigest:result.resultDigest,builder:result.builder,
    acceptedAt:now,expiresAt:null,evalConformance:{status:'PASSED',testedAt:now,checks:['capabilities','create','status','execute','evidence','delete']},
  }});
  const file=path.join(directory,'environments',`${record.environmentId}.json`);
  await writeFile(file,JSON.stringify(original));
  const transport=vi.fn();vi.stubGlobal('fetch',transport);
  await expect(store.acceptBuilderDelivery({requirements,result,trustReference:'not-used'})).rejects.toMatchObject(archivedError);
  expect(transport).not.toHaveBeenCalled();
  expect(await store.list({includeArchived:true})).toEqual([original]);
  expect(await readFile(file,'utf8')).toBe(JSON.stringify(original));
});

it('uses existing authentication for archive/list/detail and preserves read access after archive',async()=>{
  const {directory}=await fixture();
  const app=await createEvaluationService({dataDirectory:directory,rootDirectory:path.resolve('.'),accessToken:'test-only'});
  const headers={authorization:'Bearer test-only'};
  try{
    const created=await app.inject({method:'POST',url:'/api/environments',headers,payload:launcherInput});
    expect(created.statusCode).toBe(200);
    const url=`/api/environments/${created.json().environmentId}`;
    expect((await app.inject({method:'PATCH',url:`${url}/archive`,payload:{archived:true}})).statusCode).toBe(401);
    expect((await app.inject({method:'GET',url:'/api/environments?includeArchived=true'})).statusCode).toBe(401);
    expect((await app.inject({method:'GET',url})).statusCode).toBe(401);
    const archived=await app.inject({method:'PATCH',url:`${url}/archive`,headers,payload:{archived:true}});
    expect(archived.statusCode).toBe(200);
    expect(archived.json().archived).toBe(true);
    expect((await app.inject({method:'GET',url:'/api/environments',headers})).json()).toEqual([]);
    expect((await app.inject({method:'GET',url:'/api/environments?includeArchived=true',headers})).json()).toHaveLength(1);
    expect((await app.inject({method:'GET',url,headers})).json()).toEqual(archived.json());
    const transport=vi.fn();vi.stubGlobal('fetch',transport);
    expect((await app.inject({method:'POST',url:`${url}/preflight`,headers})).statusCode).toBe(409);
    expect(transport).not.toHaveBeenCalled();
    expect((await app.inject({method:'PATCH',url:'/api/environments/env-missing/archive',headers,payload:{archived:true}})).statusCode).toBe(404);
    expect((await app.inject({method:'PATCH',url:`${url}/archive`,headers,payload:{archived:false}})).json().archived).toBe(false);
  }finally{await app.close();}
});
