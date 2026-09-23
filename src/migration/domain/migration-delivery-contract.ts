import {runtimeToolConfigSchema,type RuntimeToolConfig} from '../../runtime-tool-config.js';
import {fingerprint} from '../../contracts.js';
import {supportsImplicitScriptContext,type ProjectInspection,type ToolDecision} from './migration-model.js';

export function runtimeToolConfigTemplate(inspection:ProjectInspection,decisions:ToolDecision[]){
 const runtimeToolConfig:RuntimeToolConfig={context:{},providers:{},tools:{}};
 const serviceEnvironment:Array<{name:string;dependencyKey:string;toolNames:string[];type:string;purpose:string;required:boolean;sensitive:boolean}>=[];
 const requiredEnvironment:Array<{name:string;dependencyKey:string;purpose:string}>=[],unresolved:Array<{dependencyKey:string;reason:string}>=[];
 for(const decision of decisions.filter(d=>d.form==='MCP')){
  const tool=inspection.tools.find(t=>t.toolId===decision.toolId)!;
  const contextBindings:Record<string,string>={};
  for(const dep of inspection.dependencyAnalysis?.dependencies.filter(d=>d.toolIds.includes(tool.toolId)&&d.owner==='RUNTIME'&&d.action==='INJECT')??[]){
   const type=dep.schema?.type;
   if(dep.binding?.kind==='SERVICE_ENV'){
    if(dep.contractStatus!=='KNOWN'){unresolved.push({dependencyKey:dep.key,reason:'服务环境变量契约尚未确认'});continue}
    const existing=serviceEnvironment.find(item=>item.dependencyKey===dep.key);
    if(existing)existing.toolNames.push(tool.name);
    else serviceEnvironment.push({name:dep.binding.name,dependencyKey:dep.key,toolNames:[tool.name],type:String(type),purpose:dep.purpose,required:dep.blocking,sensitive:dep.sensitive});
    continue;
   }
   if(dep.binding?.kind!=='HTTP_HEADER'||!['string','object','array','number','boolean'].includes(String(type))){unresolved.push({dependencyKey:dep.key,reason:'Header 映射或消费数据类型尚未确定，不能猜测配置'});continue}
   const name=`MIGRATION_CONTEXT_${dep.id.toUpperCase().replace(/[^A-Z0-9_]/gu,'_')}`;
   if(Object.keys(contextBindings).some(header=>header.toLowerCase()===dep.binding!.name.toLowerCase()))throw Object.assign(new Error(`工具 ${tool.name} 的 Runtime Header 映射冲突`),{statusCode:409});
   if(!runtimeToolConfig.context[dep.id])requiredEnvironment.push({name,dependencyKey:dep.key,purpose:dep.purpose});
   runtimeToolConfig.context[dep.id]={type:type as RuntimeToolConfig['context'][string]['type'],env:name,sensitive:dep.sensitive};
   contextBindings[dep.binding.name]=`context.${dep.id}`;
  }
  runtimeToolConfig.tools[tool.name]={contextBindings};
 }
 return {schemaVersion:'finance.runtime-tool-config-template.v1',runtimeToolConfig:runtimeToolConfigSchema.parse(runtimeToolConfig),requiredEnvironment,serviceEnvironment,unresolved,
  note:'serviceEnvironment 是 MCP 进程启动配置；requiredEnvironment 是按调用上下文模板所需的环境变量。实际值由执行方提供。企业凭证获取 SDK 仍由受信任 Runtime Provider 实现，不随 Tool 交付。'};
}

export function validateAgentRuntimeDelivery(payload:Record<string,unknown>,inspection:ProjectInspection,decisions:ToolDecision[]):string[]{
 const issues:string[]=[];
 const tools=(Array.isArray(payload.tools)?payload.tools.filter(t=>t&&typeof t==='object'):[]) as Array<{toolId?:string;runtimeBindings?:Array<{key?:string;header?:string}>;serviceEnvironment?:Array<{key?:string;name?:string}>;compilePassed?:boolean;contractPassed?:boolean}>;
 const ids=tools.map(t=>t.toolId);
 if(new Set(ids).size!==ids.length||ids.some(id=>!decisions.some(d=>d.toolId===id)))issues.push('A4 工具列表存在重复或未授权工具');
 for(const decision of decisions){
  const report=tools.find(t=>t.toolId===decision.toolId);
  if(!report)continue;
  if(report.compilePassed!==true||report.contractPassed!==true)issues.push(`${decision.toolId} 未完成编译或契约检查`);
  const deps=inspection.dependencyAnalysis?.dependencies.filter(d=>d.toolIds.includes(decision.toolId)&&d.owner==='RUNTIME'&&d.action==='INJECT')??[];
  const unsupportedScriptDeps=deps.filter(dep=>!supportsImplicitScriptContext(dep));
  if(decision.form==='SCRIPT'&&(unsupportedScriptDeps.length||report.runtimeBindings?.length))issues.push(`${decision.toolId} Script 不支持 Runtime 注入`);
  const callDeps=deps.filter(d=>d.binding?.kind!=='SERVICE_ENV'),serviceDeps=deps.filter(d=>d.binding?.kind==='SERVICE_ENV');
  if(decision.form==='MCP'){
   const declared=Array.isArray(report.serviceEnvironment)?report.serviceEnvironment:[];
   if(declared.length!==serviceDeps.length||serviceDeps.some(d=>declared.filter(b=>b&&b.key===d.key&&b.name===d.binding!.name).length!==1))issues.push(`${decision.toolId} 交付的服务环境变量与诊断契约不一致`);
   const bindings=Array.isArray(report.runtimeBindings)?report.runtimeBindings:[];
   if(bindings.length!==callDeps.length||callDeps.some(d=>bindings.filter(b=>b&&b.key===d.key&&typeof b.header==='string'&&b.header.toLowerCase()===d.binding?.name.toLowerCase()).length!==1))issues.push(`${decision.toolId} 交付的 Header 绑定与诊断契约不一致`);
  }
 }
 const expected=runtimeToolConfigTemplate(inspection,decisions);
 if(payload.runtimeToolConfig!==undefined){
  const outer=payload.runtimeToolConfig;
  // Some agents copy the deterministic template envelope into the field instead of copying only
  // its runtimeToolConfig member. Accept that shape only when it is the known version and unwrap
  // it before the same exact fingerprint check; arbitrary wrappers and extra identity data remain
  // rejected by runtimeToolConfigSchema.
  const wrapped=outer&&typeof outer==='object'&&!Array.isArray(outer)
   &&(outer as Record<string,unknown>).schemaVersion==='finance.runtime-tool-config-template.v1'
   ?(outer as Record<string,unknown>).runtimeToolConfig:undefined;
  const parsed=runtimeToolConfigSchema.safeParse(wrapped??outer);
  if(!parsed.success||fingerprint(parsed.data)!==fingerprint(expected.runtimeToolConfig))issues.push('A4 Runtime 配置与已确认依赖模板不一致，不接受新增身份逻辑或实际凭证');
 }else if(expected.requiredEnvironment.length)issues.push('A4 缺少配套 runtimeToolConfig');
 return issues;
}
