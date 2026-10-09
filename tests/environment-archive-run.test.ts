import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, expect, it, vi} from 'vitest';
import {loadEvalPack} from '../src/eval-pack.js';
import {EnvironmentStore} from '../src/service/environment-store.js';
import {EvaluationJobStore} from '../src/service/job-store.js';
import {EvaluationRunManager} from '../src/service/run-manager.js';
import {createEvaluationService} from '../src/service/server.js';

const directories:string[]=[];
afterEach(async()=>{
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(directories.splice(0).map(directory=>rm(directory,{recursive:true,force:true})));
});
const launcherInput={name:'Acceptance is not an archive flag',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:'http://127.0.0.1:9000/'};
const archivedError={statusCode:409,code:'ENVIRONMENT_ARCHIVED'};
const variant={mode:'skill_version',skillId:'fixture',version:'1.0.0',artifactSha256:'a'.repeat(64)};
const model={providerId:'fixture',modelId:'execution',parameters:{}};

async function fixture(){
  const directory=await mkdtemp(path.join(tmpdir(),'eval-archive-run-'));
  directories.push(directory);
  const environments=new EnvironmentStore(directory);
  const jobs=new EvaluationJobStore(directory);
  await environments.initialize();await jobs.initialize();
  const launcher=await environments.create(launcherInput);
  const pack=await loadEvalPack(path.resolve('packs/finance/wealth-online/eval.yaml'));
  const manager=new EvaluationRunManager({jobs,environments,maxConcurrentRuns:1,
    catalog:{get:()=>structuredClone(pack)} as never,preparations:{} as never,
    skills:{list:async()=>[]} as never,
    // A stale resolver must not bypass resolveLauncher's fresh registry check.
    resolveMigrationRuntime:async id=>id===launcher.environmentId?launcher:null,
  });
  const queue=manager as unknown as {pump():Promise<void>};
  const paused=vi.spyOn(queue,'pump').mockResolvedValue(undefined);
  const transport=vi.fn(()=>{throw new Error('No model or Launcher transport is allowed');});
  vi.stubGlobal('fetch',transport);
  return {directory,environments,jobs,launcher,manager,queue,paused,transport,pack,
    config:{packId:pack.packId,runtime:{type:'runtime_launcher',environmentId:launcher.environmentId}}};
}

it.each(['direct','launcher-dependency','mcp-dependency'] as const)(
  'rejects new run admission for archived %s before saving or contacting a runtime',async kind=>{
    const f=await fixture();
    let selectedId=f.launcher.environmentId;
    let archiveId=selectedId;
    if(kind!=='direct'){
      const mcp=await f.environments.create({name:'MCP',type:'mcp_streamable_http',endpoint:'http://127.0.0.1:9001/mcp'});
      const execution=await f.environments.create({name:'Execution',type:'execution_environment',
        launcherEnvironmentId:f.launcher.environmentId,mcpEnvironmentIds:[mcp.environmentId]});
      selectedId=execution.environmentId;
      if(kind==='mcp-dependency')archiveId=mcp.environmentId;
    }
    await f.environments.setArchived(archiveId,{archived:true});
    const save=vi.spyOn(f.jobs,'save');
    await expect(f.manager.create({...f.config,runtime:{type:'runtime_launcher',environmentId:selectedId}})).rejects.toMatchObject(archivedError);
    expect(save).not.toHaveBeenCalled();
    expect(f.jobs.list()).toEqual([]);
    expect(f.transport).not.toHaveBeenCalled();
  });

it.each(['left','right'] as const)('checks archived %s bindings for paired runs',async side=>{
  const f=await fixture();
  const other=await f.environments.create({...launcherInput,name:'Other runtime'});
  const bindings={left:{environmentId:f.launcher.environmentId,skillAssetId:'asset'},right:{environmentId:other.environmentId,skillAssetId:'asset'}};
  await f.environments.setArchived(bindings[side].environmentId,{archived:true});
  await expect(f.manager.create({...f.config,runtimeBindings:bindings,leftVariant:variant,rightVariant:variant,executionModel:model})).rejects.toMatchObject(archivedError);
  expect(f.jobs.list()).toEqual([]);
  expect(f.transport).not.toHaveBeenCalled();
});

it('checks only the used candidate side without upgrading an unused source binding to an execution',async()=>{
  const f=await fixture();
  const unused=await f.environments.create({...launcherInput,name:'Unused baseline'});
  await f.environments.setArchived(unused.environmentId,{archived:true});
  const config={...f.config,evaluationMode:'candidate_assessment',executionModel:model,
    leftVariant:variant,rightVariant:variant,runtimeBindings:{
      left:{environmentId:unused.environmentId,skillAssetId:'source'},
      right:{environmentId:f.launcher.environmentId,skillAssetId:'candidate'},
    }};
  const admitted=await f.manager.create(config);
  expect(admitted.status).toBe('queued');
  await f.manager.cancel(admitted.jobId);
  await f.environments.setArchived(f.launcher.environmentId,{archived:true});
  await expect(f.manager.create(config)).rejects.toMatchObject(archivedError);
  expect(f.jobs.list()).toHaveLength(1);
  expect(f.transport).not.toHaveBeenCalled();
});

it('rechecks archive state on retry, preserves the original history, and permits an explicit restore',async()=>{
  const f=await fixture();
  const original=await f.manager.create(f.config);
  await f.manager.cancel(original.jobId);
  const file=path.join(f.directory,'runs',`${original.jobId}.json`);
  const frozen=await readFile(file,'utf8');
  await f.environments.setArchived(f.launcher.environmentId,{archived:true});
  await expect(f.manager.retry(original.jobId)).rejects.toMatchObject(archivedError);
  expect(f.jobs.list()).toHaveLength(1);
  expect(f.jobs.get(original.jobId)?.status).toBe('cancelled');
  expect(await readFile(file,'utf8')).toBe(frozen);
  expect(await f.environments.get(f.launcher.environmentId)).toMatchObject({archived:true});
  await f.environments.setArchived(f.launcher.environmentId,{archived:false});
  const retried=await f.manager.retry(original.jobId);
  expect(retried.jobId).not.toBe(original.jobId);
  expect(retried.configuration).toEqual(original.configuration);
  expect(retried.status).toBe('queued');
  expect(await readFile(file,'utf8')).toBe(frozen);
  await f.manager.cancel(retried.jobId);
  expect(f.transport).not.toHaveBeenCalled();
});

it.each(['direct','stale-migration-resolver'] as const)(
  'fails a previously queued %s run after archive before model/Launcher dispatch',async mode=>{
    const f=await fixture();
    const config=mode==='direct'?f.config:{...f.config,evaluationMode:'candidate_assessment',executionModel:model,
      leftVariant:variant,rightVariant:variant,runtimeBindings:{
        left:{environmentId:f.launcher.environmentId,skillAssetId:'source'},
        right:{environmentId:f.launcher.environmentId,skillAssetId:'candidate'},
      }};
    const job=await f.manager.create(config);
    expect(f.jobs.get(job.jobId)?.status).toBe('queued');
    await f.environments.setArchived(f.launcher.environmentId,{archived:true});
    const resolve=vi.spyOn(f.environments,'resolveLauncher');
    f.paused.mockRestore();
    await f.queue.pump();
    await vi.waitFor(()=>expect(f.jobs.get(job.jobId)?.status).toBe('failed'));
    expect(f.jobs.get(job.jobId)?.error).toMatchObject({code:'ENVIRONMENT_PREFLIGHT_FAILED',message:'Environment is archived'});
    expect(f.jobs.get(job.jobId)?.evidence).toEqual([]);
    expect(f.jobs.get(job.jobId)?.report).toBeNull();
    if(mode==='stale-migration-resolver')expect(resolve).toHaveBeenCalledWith(f.launcher);
    expect(f.transport).not.toHaveBeenCalled();
    expect(f.jobs.list()).toHaveLength(1);
  });

it('catalog offers exactly two active runtimes while retaining four archived registrations for management',async()=>{
  const f=await fixture();
  const records=[f.launcher];
  for(let index=1;index<6;index++)records.push(await f.environments.create({...launcherInput,
    name:index<2?'Acceptance active':'Ordinary archived',baseUrl:`http://127.0.0.1:9000/fixture-${index}/`}));
  for(const record of records.slice(2))await f.environments.setArchived(record.environmentId,{archived:true});
  const capabilities={schemaVersion:'finance.skill-eval.runtime-capabilities.v1',runtime:{type:'openjiuwen',version:'0.1.15'},
    models:[{modelId:'execution',upstreamModelId:'synthetic-model'}],defaultModelId:'execution',nativeToolNames:['fixture_read','fixture_describe'],
    features:{streaming:false,asyncLaunch:true,packagedMcp:false,externalMcp:false,inlineSecrets:false},
    limits:{maxArchiveBytes:1024,maxFiles:20,maxTimeoutMs:300000,maxConcurrentInstances:2}};
  const contacted:string[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:URL|string)=>{contacted.push(String(url));return Response.json(capabilities);}));
  const app=await createEvaluationService({dataDirectory:f.directory,rootDirectory:path.resolve('.'),accessToken:'test-only'});
  const headers={authorization:'Bearer test-only'};
  try{
    const response=await app.inject({method:'GET',url:'/api/catalog',headers});
    expect(response.statusCode).toBe(200);
    const catalog=response.json();
    expect(catalog.environments).toHaveLength(6);
    expect(catalog.environments.filter((record:{archived:boolean})=>record.archived)).toHaveLength(4);
    expect(catalog.executionRuntimes).toHaveLength(2);
    expect(catalog.executionRuntimes.map((runtime:{runtimeId:string})=>runtime.runtimeId).sort()).toEqual(records.slice(0,2).map(record=>record.environmentId).sort());
    expect(catalog.executionRuntimes.every((runtime:{toolCount:number})=>runtime.toolCount===2)).toBe(true);
    expect(contacted.sort()).toEqual(records.slice(0,2).map(record=>new URL('v1/runtime-capabilities',record.type==='runtime_launcher'?record.baseUrl:'').toString()).sort());
    expect((await app.inject({method:'GET',url:'/api/environments',headers})).json()).toHaveLength(2);
    expect((await app.inject({method:'GET',url:'/api/environments?includeArchived=true',headers})).json()).toHaveLength(6);
    for(const record of records.slice(2)){
      const detail=await app.inject({method:'GET',url:`/api/environments/${record.environmentId}`,headers});
      expect(detail.statusCode).toBe(200);expect(detail.json().archived).toBe(true);
    }
  }finally{await app.close();}
});
