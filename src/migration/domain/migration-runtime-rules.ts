import {validateServiceEnvironment} from '../../shared/contracts/service-environment.js';
import {runtimeToolConfigSchema,type RuntimeToolConfig} from '../../runtime-tool-config.js';
import type {Dependency} from './migration-dependency.js';
import {validateDependencyData} from './migration-dependency-schema.js';
import {supportsImplicitScriptContext} from './migration-model.js';

const reserved=/^(?:host|content-length|connection|transfer-encoding|content-type|accept|mcp-session-id|mcp-protocol-version)$/iu;

export function runtimeInjection(dependencies:Dependency[],values:Record<string,unknown>,kind:'HTTP_HEADER'|'SCRIPT_CONTEXT'){
  const headers:Record<string,string>={},context:Record<string,unknown>={},missing:string[]=[];
  for(const dep of dependencies.filter(d=>d.owner==='RUNTIME'&&d.action==='INJECT'&&d.binding?.kind!=='SERVICE_ENV')){
    if(kind==='SCRIPT_CONTEXT'){
      if(supportsImplicitScriptContext(dep))continue;
      missing.push(`${dep.name}（Script 不支持 Runtime 注入）`);continue;
    }
    if(!(dep.id in values)){if(dep.blocking)missing.push(dep.name);continue}
    const errors=validateDependencyData(values[dep.id],dep.schema);if(errors.length){missing.push(`${dep.name}（格式已变化）`);continue}
    const binding=dep.binding;if(!binding){missing.push(`${dep.name}（注入位置未确认）`);continue}
    if(binding.kind!=='HTTP_HEADER'){missing.push(`${dep.name}（未声明 HTTP header 映射）`);continue}
    const name=binding.name.toLowerCase(),value=typeof values[dep.id]==='string'?values[dep.id] as string:JSON.stringify(values[dep.id]);
    if(!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name)||reserved.test(name)||/[\r\n\x00]/u.test(value)||name in headers){missing.push(`${dep.name}（header 映射无效或冲突）`);continue}
    headers[name]=value;
  }
  return {headers,context,missing};
}

export function serviceEnvironment(dependencies:Dependency[],values:Record<string,unknown>):Record<string,string>{
  const environment:Record<string,string>={};
  for(const dep of dependencies.filter(d=>d.owner==='RUNTIME'&&d.action==='INJECT'&&d.binding?.kind==='SERVICE_ENV')){
    if(dep.contractStatus!=='KNOWN')throw new Error(`服务配置契约尚未确认：${dep.name}`);
    if(!(dep.id in values)){if(dep.blocking)throw new Error(`请先填写服务配置：${dep.name}`);continue}
    const value=values[dep.id];
    if(validateDependencyData(value,dep.schema).length||!['string','number','boolean'].includes(typeof value)||(typeof value==='number'&&!Number.isFinite(value))||value==='')throw new Error(`服务配置格式不合法：${dep.name}`);
    const name=dep.binding!.name;
    if(Object.keys(environment).some(key=>key===name)&&environment[name]!==String(value))throw new Error('同一服务的环境变量配置冲突');
    environment[name]=String(value);
  }
  return validateServiceEnvironment(environment);
}

/** Migration is a producer of the shared contract, never a Runtime execution protocol. */
export function migrationExecutionConfig(dependencies:Dependency[],values:Record<string,unknown>,tools:Array<{toolId:string;name:string;kind?:string}>):RuntimeToolConfig{
  const config:RuntimeToolConfig={context:{},providers:{},tools:{}};
  for(const tool of tools){
    const contextBindings:Record<string,string>={},headerNames=new Set<string>();
    for(const dep of dependencies.filter(d=>d.owner==='RUNTIME'&&d.action==='INJECT'&&d.binding?.kind!=='SERVICE_ENV'&&d.toolIds.includes(tool.toolId))){
      if(tool.kind==='SCRIPT'&&supportsImplicitScriptContext(dep))continue;
      if(tool.kind==='SCRIPT')throw new Error('Script 不支持 Runtime 上下文或鉴权注入，请迁移为 MCP');
      if(dep.binding?.kind!=='HTTP_HEADER')throw new Error(`MCP 依赖尚未声明 Header 映射：${dep.name}`);
      if(!(dep.id in values)){if(dep.blocking)throw new Error(`测试运行依赖未就绪：${dep.name}`);continue}
      if(validateDependencyData(values[dep.id],dep.schema).length)throw new Error(`测试运行依赖格式未确认：${dep.name}`);
      const mapped=runtimeInjection([dep],values,'HTTP_HEADER');if(mapped.missing.length)throw new Error(mapped.missing.join('、'));
      const header=dep.binding.name.toLowerCase();if(headerNames.has(header))throw new Error('Runtime Header 映射冲突');headerNames.add(header);
      const value=values[dep.id],type=Array.isArray(value)?'array':typeof value==='object'&&value!==null?'object':typeof value;
      if(!['string','object','array','number','boolean'].includes(type))throw new Error(`测试运行依赖类型不支持：${dep.name}`);
      config.context[dep.id]={type:type as RuntimeToolConfig['context'][string]['type'],value,sensitive:dep.sensitive};
      contextBindings[dep.binding.name]=`context.${dep.id}`;
    }
    if(tool.kind!=='SCRIPT')config.tools[tool.name]={contextBindings};
  }
  return runtimeToolConfigSchema.parse(config);
}
