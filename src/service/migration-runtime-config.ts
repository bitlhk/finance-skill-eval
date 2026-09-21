import path from 'node:path';
import {validateServiceEnvironment} from './service-environment.js';
import {randomUUID} from 'node:crypto';
import {fingerprint} from '../contracts.js';
import {readJson,writeJsonAtomic} from './file-store.js';
import {validateDependencyData,type Dependency} from './migration-dependencies.js';
import {runtimeToolConfigSchema,type RuntimeToolConfig} from '../runtime-tool-config.js';
import {supportsImplicitScriptContext} from './migration-model.js';

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

export type ConnectionCheck={id:string;toolId:string;kind:'BUSINESS_INTERFACE'|'GENERATED_TOOL'|'SOURCE_TOOL';status:'PASSED'|'FAILED';configurationDigest:string;assetDigest:string;checkedAt:string;message:string;httpStatus?:number;validationId?:string};
export type RuntimeTestConfig={revision:number;values:Record<string,unknown>;checks:ConnectionCheck[]};
export const configurationDigest=(config:RuntimeTestConfig,dependencies:Dependency[]=[])=>fingerprint([config.revision,config.values,dependencies]);
export class MigrationRuntimeConfig{
 constructor(private root:string){}
 private file(id:string){if(!/^migration-[a-f0-9-]+$/u.test(id))throw new Error('迁移项目不合法');return path.join(this.root,'migration-runtime-config',id+'.json')}
 async get(id:string):Promise<RuntimeTestConfig>{try{return await readJson(this.file(id))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {revision:0,values:{},checks:[]};throw e}}
 async save(id:string,dependency:Dependency,value:unknown,revision:number){const config=await this.get(id);if(config.revision!==revision)throw Object.assign(new Error('测试配置已变化，请刷新后保存'),{statusCode:409});if(dependency.binding?.kind==='SERVICE_ENV'){try{serviceEnvironment([dependency],{[dependency.id]:value})}catch(e){throw Object.assign(e instanceof Error?e:new Error('服务配置不合法'),{statusCode:400})}}const errors=validateDependencyData(value,dependency.schema);if(errors.length)throw Object.assign(new Error(errors.join('；')),{statusCode:400});if(Buffer.byteLength(JSON.stringify(value))>128000)throw Object.assign(new Error('测试数据超过 128 KB'),{statusCode:400});config.revision++;config.values[dependency.id]=value;await writeJsonAtomic(this.file(id),config);return config}
 async check(id:string,result:Omit<ConnectionCheck,'id'|'checkedAt'>){const config=await this.get(id);const check={...result,id:'connection-'+randomUUID(),checkedAt:new Date().toISOString()};config.checks=[...config.checks.slice(-49),check];await writeJsonAtomic(this.file(id),config);return check}
}

const reserved=/^(?:host|content-length|connection|transfer-encoding|content-type|accept|mcp-session-id|mcp-protocol-version)$/iu;
export function runtimeInjection(dependencies:Dependency[],values:Record<string,unknown>,kind:'HTTP_HEADER'|'SCRIPT_CONTEXT'){
 const headers:Record<string,string>={},context:Record<string,unknown>={},missing:string[]=[];
 for(const dep of dependencies.filter(d=>d.owner==='RUNTIME'&&d.action==='INJECT'&&d.binding?.kind!=='SERVICE_ENV')){
  if(kind==='SCRIPT_CONTEXT'){
   if(supportsImplicitScriptContext(dep))continue;
   missing.push(`${dep.name}（Script 不支持 Runtime 注入）`);continue
  }
  if(!(dep.id in values)){if(dep.blocking)missing.push(dep.name);continue}
  const errors=validateDependencyData(values[dep.id],dep.schema);if(errors.length){missing.push(`${dep.name}（格式已变化）`);continue}
  const binding=dep.binding;if(!binding){missing.push(`${dep.name}（注入位置未确认）`);continue}
  if(kind==='HTTP_HEADER'){
   if(binding.kind!=='HTTP_HEADER'){missing.push(`${dep.name}（未声明 HTTP header 映射）`);continue}
   const name=binding.name.toLowerCase(),value=typeof values[dep.id]==='string'?values[dep.id] as string:JSON.stringify(values[dep.id]);
   if(!/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name)||reserved.test(name)||/[\r\n\x00]/u.test(value)||name in headers){missing.push(`${dep.name}（header 映射无效或冲突）`);continue}headers[name]=value;
  }else{if(binding.name in context){missing.push(`${dep.name}（上下文名称冲突）`);continue}context[binding.name]=values[dep.id]}
 }
 return {headers,context,missing};
}

/** No response bodies or server error messages are retained; they may contain credentials. */
export async function probeBusinessInterface(url:string,method:'GET'|'HEAD',headers:Record<string,string>,signal?:AbortSignal){
 const endpoint=new URL(url);if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password)throw Object.assign(new Error('请提供不包含账号密码的 HTTP 接口地址'),{statusCode:400});
 try{const response=await fetch(endpoint,{method,headers,redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});await response.body?.cancel();const passed=response.ok;return {status:passed?'PASSED' as const:'FAILED' as const,httpStatus:response.status,message:passed?'业务接口返回成功；尚未验证迁移工具与业务结果。':`业务接口返回 HTTP ${response.status}；未跟随重定向。`}}catch{return {status:'FAILED' as const,message:signal?.aborted?'连通验证已取消。':'接口连接失败或超时，请检查地址、网络与测试配置。'}}
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
