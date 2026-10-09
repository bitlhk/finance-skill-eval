import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJson,writeJsonAtomic } from '../service/file-store.js';
import type { ExecutionConfiguration,ExecutionConfigurationCheck,ExecutionConfigurationRepository } from './execution-configuration.js';

/** File adapter shared by features that need revisioned execution values and validation evidence. */
export class FileExecutionConfigurationRepository<TCheck extends ExecutionConfigurationCheck> implements ExecutionConfigurationRepository<TCheck> {
  constructor(private readonly root:string,private readonly namespace:string,private readonly validScope:(scopeId:string)=>boolean=scopeId=>/^[a-z0-9-]+$/u.test(scopeId)){}

  private file(scopeId:string){
    if(!this.validScope(scopeId))throw Object.assign(new Error('执行配置作用域不合法'),{statusCode:400});
    return path.join(this.root,this.namespace,`${scopeId}.json`);
  }

  async get(scopeId:string):Promise<ExecutionConfiguration<TCheck>>{
    try{return await readJson(this.file(scopeId));}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {revision:0,values:{},checks:[]};throw error;}
  }

  async saveValue(scopeId:string,key:string,value:unknown,revision:number){
    const config=await this.get(scopeId);
    if(config.revision!==revision)throw Object.assign(new Error('执行配置已变化，请刷新后保存'),{statusCode:409});
    config.revision+=1;config.values[key]=value;
    await writeJsonAtomic(this.file(scopeId),config);
    return config;
  }

  async appendCheck(scopeId:string,result:Omit<TCheck,'id'|'checkedAt'>){
    const config=await this.get(scopeId);
    const check={...result,id:`connection-${randomUUID()}`,checkedAt:new Date().toISOString()} as TCheck;
    config.checks=[...config.checks.slice(-49),check];
    await writeJsonAtomic(this.file(scopeId),config);
    return check;
  }

  async saveValidationInput(scopeId:string,toolId:string,input:unknown){
    if(Buffer.byteLength(JSON.stringify(input))>128000)throw new Error('工具测试参数超过 128 KB');
    const config=await this.get(scopeId);(config.validationInputs??={})[toolId]=input;
    await writeJsonAtomic(this.file(scopeId),config);
  }
}
