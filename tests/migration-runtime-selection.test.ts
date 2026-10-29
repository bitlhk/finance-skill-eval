import {afterEach,expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EnvironmentStore} from '../src/service/environment-store.js';
import {resolveMigrationRuntimeSelection} from '../src/interfaces/http/migration-runtime-selection.js';

const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllGlobals();await Promise.all(dirs.splice(0).map(dir=>rm(dir,{recursive:true,force:true})));});
async function fixture(){
  const dir=await mkdtemp(path.join(tmpdir(),'migration-runtime-selection-'));dirs.push(dir);
  const store=new EnvironmentStore(dir);await store.initialize();
  const left=await store.create({name:'OJ',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:'http://127.0.0.1:18001/'});
  const right=await store.create({name:'AS',type:'runtime_launcher',runtimeType:'agentscope',baseUrl:'http://127.0.0.1:18002/'});
  const caps=(type:string)=>({schemaVersion:'finance.runtime-capabilities.v1',instanceSchemaVersion:'finance.runtime-instance.v1',platform:{os:'linux',arch:'x64',isolation:'trusted_local_process'},runtime:{type,version:type==='openjiuwen'?'0.1.15':'2.0.3'},models:[{modelId:'model',upstreamModelId:'same-model'}],defaultModelId:'model',features:{streaming:false,asyncLaunch:true,packagedMcp:false,externalMcp:false,inlineSecrets:false},limits:{maxSkills:10,maxArchiveBytes:1024,maxFiles:20,maxTimeoutMs:300000,maxConcurrentInstances:2}});
  vi.stubGlobal('fetch',vi.fn(async(url:URL|string)=>Response.json(caps(String(url).includes('18001')?'openjiuwen':'agentscope'))));
  const body={pair:'CC',configuration:{runtime:{type:'runtime_launcher',environmentId:left.environmentId},runtimeBindings:{left:{environmentId:left.environmentId,skillAssetId:'same'},right:{environmentId:right.environmentId,skillAssetId:'same'}},executionModel:{modelId:'model',parameters:{temperature:0.2,top_p:0.9,max_tokens:1024}}}};
  return {store,body,caps};
}
it('resolves both real runtime declarations without erasing requested generation parameters',async()=>{
  const {store,body}=await fixture();
  const result=await resolveMigrationRuntimeSelection(body,store);
  expect(result.configuration.leftExecutionModel.parameters).toEqual(body.configuration.executionModel.parameters);
  expect(result.configuration.rightExecutionModel.parameters).toEqual(body.configuration.executionModel.parameters);
  expect(result.configuration.leftExecutionModel.providerId).not.toBe(result.configuration.rightExecutionModel.providerId);
  expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
});
it('does not disguise different upstream models as the same comparison model',async()=>{
  const {store,body,caps}=await fixture();
  vi.stubGlobal('fetch',vi.fn(async(url:URL|string)=>{
    const left=String(url).includes('18001'),value=caps(left?'openjiuwen':'agentscope');
    if(!left)value.models[0]!.upstreamModelId='different-model';
    return Response.json(value);
  }));
  await expect(resolveMigrationRuntimeSelection(body,store)).rejects.toThrow('相同模型');
});
it('rejects unsupported generation fields instead of silently ignoring them',async()=>{
  const {store,body}=await fixture();
  await expect(resolveMigrationRuntimeSelection({...body,configuration:{...body.configuration,executionModel:{modelId:'model',parameters:{...body.configuration.executionModel.parameters,seed:1}}}},store)).rejects.toThrow();
});
it('keeps source/candidate experiments on one environment',async()=>{
  const {store,body}=await fixture();
  await expect(resolveMigrationRuntimeSelection({...body,pair:'AB'},store)).rejects.toThrow('同一执行环境');
});
it('supports other registered Launcher versions without pinning product logic to demo Java releases',async()=>{
  const {store,body,caps}=await fixture();
  vi.stubGlobal('fetch',vi.fn(async(url:URL|string)=>{
    const value=caps(String(url).includes('18001')?'openjiuwen':'agentscope');
    value.runtime.version='9.8.7';return Response.json(value);
  }));
  expect((await resolveMigrationRuntimeSelection(body,store)).configuration.leftExecutionModel.modelId).toBe('model');
});
