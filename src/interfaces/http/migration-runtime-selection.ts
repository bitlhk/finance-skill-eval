import { z } from 'zod';
import { fingerprint } from '../../contracts.js';
import { launcherGenerationSchema } from '../../runtime-launcher.js';
import type { EnvironmentStore } from '../../service/environment-store.js';

const selectionSchema=z.object({
  pair:z.string(),
  configuration:z.object({
    runtime:z.object({type:z.literal('runtime_launcher'),environmentId:z.string().min(1)}),
    runtimeBindings:z.object({left:z.object({environmentId:z.string().min(1)}).passthrough(),right:z.object({environmentId:z.string().min(1)}).passthrough()}),
    executionModel:z.object({modelId:z.string().min(1),parameters:z.record(z.unknown()).default({})}).passthrough(),
    leftExecutionModel:z.object({modelId:z.string().min(1),parameters:z.record(z.unknown()).default({})}).passthrough().optional(),
    rightExecutionModel:z.object({modelId:z.string().min(1),parameters:z.record(z.unknown()).default({})}).passthrough().optional(),
  }).passthrough(),
}).passthrough();
function invalid(message:string):never {throw Object.assign(new Error(message),{statusCode:400});}

export async function resolveMigrationRuntimeSelection(input:unknown,environments:Pick<EnvironmentStore,'get'|'inspect'>) {
  const body=selectionSchema.parse(input),config=body.configuration;
  const dual=body.pair==='CC';
  const models=[];
  const nativeTypes=[];
  for(const side of ['left','right'] as const){
    const id=config.runtimeBindings[side].environmentId;
    if(!dual&&id!==config.runtime.environmentId)invalid('迁移前后对照必须使用同一执行环境');
    const environment=await environments.get(id);
    if(!environment||!['runtime_launcher','execution_environment'].includes(environment.type))invalid('执行环境不存在');
    const inspection=await environments.inspect(environment),caps=inspection.capabilities;
    if(inspection.status!=='ready'||!caps)invalid(inspection.error??'Runtime Launcher 预检失败');
    if(dual&&!((caps.runtime.type==='openjiuwen'&&caps.runtime.version==='0.1.15')
      ||(caps.runtime.type==='agentscope'&&caps.runtime.version==='2.0.3')))
      invalid('本轮跨 Runtime 对照仅支持 OpenJiuwen Java 0.1.15 与 AgentScope Java 2.0.3');
    nativeTypes.push(caps.runtime.type);
    const selected=config[side==='left'?'leftExecutionModel':'rightExecutionModel']??config.executionModel;
    const model=caps.models.find(item=>item.modelId===selected.modelId);
    if(!model)invalid('所选执行模型不属于这个 Runtime Launcher');
    const parameters=Object.keys(selected.parameters).length
      ? launcherGenerationSchema.omit({schemaVersion:true}).parse(selected.parameters)
      : dual ? {temperature:0,top_p:1,max_tokens:2048} : {};
    models.push({upstreamModelId:model.upstreamModelId,ref:{providerId:`runtime-launcher:${id}`,modelId:model.modelId,label:model.label??model.upstreamModelId,parameters}});
  }
  if(dual){
    if(config.runtime.environmentId!==config.runtimeBindings.left.environmentId)invalid('主执行环境必须对应左侧绑定');
    if(new Set(nativeTypes).size!==2)invalid('跨 Runtime 对照需要两个不同的原生框架');
    if(models[0]!.upstreamModelId!==models[1]!.upstreamModelId||fingerprint(models[0]!.ref.parameters)!==fingerprint(models[1]!.ref.parameters))invalid('跨 Runtime 对照必须使用相同模型与生成参数');
  }
  return {...body,configuration:{...config,executionModel:models[0]!.ref,leftExecutionModel:models[0]!.ref,rightExecutionModel:models[1]!.ref}};
}
