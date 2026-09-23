import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {readJson,writeJsonAtomic} from '../../service/file-store.js';
import {validateDependencyData} from '../domain/migration-dependency-schema.js';
import type {Dependency} from '../domain/migration-dependency.js';
import type {ConnectionCheck,MigrationRuntimeConfigurationRepository,RuntimeTestConfig} from '../application/migration-runtime-configuration-repository.js';
import {serviceEnvironment} from '../domain/migration-runtime-rules.js';
import type {MigrationBusinessConnectionProbe} from '../application/migration-business-connection-probe.js';
export type {ConnectionCheck,RuntimeTestConfig} from '../application/migration-runtime-configuration-repository.js';
export {configurationDigest} from '../domain/migration-runtime-configuration.js';
export {migrationExecutionConfig,runtimeInjection,serviceEnvironment} from '../domain/migration-runtime-rules.js';

export class MigrationRuntimeConfig implements MigrationRuntimeConfigurationRepository {
 constructor(private root:string){}
 private file(id:string){if(!/^migration-[a-f0-9-]+$/u.test(id))throw new Error('迁移项目不合法');return path.join(this.root,'migration-runtime-config',id+'.json')}
 async get(id:string):Promise<RuntimeTestConfig>{try{return await readJson(this.file(id))}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return {revision:0,values:{},checks:[]};throw e}}
 async save(id:string,dependency:Dependency,value:unknown,revision:number){const config=await this.get(id);if(config.revision!==revision)throw Object.assign(new Error('测试配置已变化，请刷新后保存'),{statusCode:409});if(dependency.binding?.kind==='SERVICE_ENV'){try{serviceEnvironment([dependency],{[dependency.id]:value})}catch(e){throw Object.assign(e instanceof Error?e:new Error('服务配置不合法'),{statusCode:400})}}const errors=validateDependencyData(value,dependency.schema);if(errors.length)throw Object.assign(new Error(errors.join('；')),{statusCode:400});if(Buffer.byteLength(JSON.stringify(value))>128000)throw Object.assign(new Error('测试数据超过 128 KB'),{statusCode:400});config.revision++;config.values[dependency.id]=value;await writeJsonAtomic(this.file(id),config);return config}
 async check(id:string,result:Omit<ConnectionCheck,'id'|'checkedAt'>){const config=await this.get(id);const check={...result,id:'connection-'+randomUUID(),checkedAt:new Date().toISOString()};config.checks=[...config.checks.slice(-49),check];await writeJsonAtomic(this.file(id),config);return check}
}

/** No response bodies or server error messages are retained; they may contain credentials. */
export async function probeBusinessInterface(url:string,method:'GET'|'HEAD',headers:Record<string,string>,signal?:AbortSignal){
 const endpoint=new URL(url);if(!['http:','https:'].includes(endpoint.protocol)||endpoint.username||endpoint.password)throw Object.assign(new Error('请提供不包含账号密码的 HTTP 接口地址'),{statusCode:400});
 try{const response=await fetch(endpoint,{method,headers,redirect:'manual',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000)});await response.body?.cancel();const passed=response.ok;return {status:passed?'PASSED' as const:'FAILED' as const,httpStatus:response.status,message:passed?'业务接口返回成功；尚未验证迁移工具与业务结果。':`业务接口返回 HTTP ${response.status}；未跟随重定向。`}}catch{return {status:'FAILED' as const,message:signal?.aborted?'连通验证已取消。':'接口连接失败或超时，请检查地址、网络与测试配置。'}}
}

export class HttpMigrationBusinessConnectionProbe implements MigrationBusinessConnectionProbe {
 async probe(url:string,method:'GET'|'HEAD',headers:Record<string,string>,signal?:AbortSignal){
  return probeBusinessInterface(url,method,headers,signal);
 }
}
