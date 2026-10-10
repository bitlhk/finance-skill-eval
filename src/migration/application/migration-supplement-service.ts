import {z} from 'zod';
import type {Supplement} from '../domain/migration-dependency.js';
import {isExecutionInput} from '../domain/migration-dependency.js';
import {validateDependencyData} from '../domain/migration-dependency-schema.js';
import {migrationConflict as conflict} from './migration-errors.js';
import type {MigrationProjectStore} from './migration-project-store.js';
import type {MigrationSupplementRepository} from './migration-supplement-repository.js';

export class MigrationSupplementService {
  constructor(
    private readonly projects:MigrationProjectStore,
    private readonly supplements:MigrationSupplementRepository,
  ) {}

  async supplementDependency(id:string,dependencyId:string,input:unknown){
    return this.projects.runExclusive(id,async()=>{
      const parsed=z.strictObject({revision:z.number().int().nonnegative(),value:z.unknown()}).parse(input);
      if(!Object.prototype.hasOwnProperty.call(parsed,'value'))return conflict('请提供数据');
      return this.saveDependency(id,dependencyId,parsed.revision,{value:parsed.value});
    });
  }

  async uploadDependency(id:string,dependencyId:string,revision:number,filename:string,bytes:Buffer){
    return this.projects.runExclusive(id,()=>this.saveDependency(id,dependencyId,revision,
      {files:this.supplements.unpack(dependencyId,filename,bytes),filename}));
  }

  async explainDependency(id:string,dependencyId:string,input:unknown){
    return this.projects.runExclusive(id,async()=>{
      const parsed=z.strictObject({revision:z.number().int().nonnegative(),explanation:z.string().trim().min(1).max(16000)}).parse(input);
      const previous=(await this.supplements.get(id)).items.find(item=>item.dependencyId===dependencyId);
      const supplementPath=`.diagnosis-supplements/${dependencyId}/dependency-contract.md`;
      return this.saveDependency(id,dependencyId,parsed.revision,{
        files:{...previous?.files,[supplementPath]:Buffer.from(parsed.explanation,'utf8').toString('base64')},
        filename:previous?.filename??'dependency-contract.md',
      },true);
    });
  }

  private async saveDependency(id:string,dependencyId:string,revision:number,content:Partial<Supplement>,explanation=false){
    const value=await this.projects.get(id),diagnostic=value.sourceInspection?.dependencyAnalysis;
    const dependency=diagnostic?.dependencies.find(item=>item.id===dependencyId);
    if(!dependency)return conflict('缺项已变化，请刷新诊断');
    if(isExecutionInput(dependency)&&!explanation)return conflict('调用输入请通过试运行参数或评测案例提供，不作为迁移补充材料保存');
    if(dependency.owner!=='TOOL'&&!explanation)return conflict('运行时依赖请在运行配置中提供；归属未确认的依赖请补充契约说明');
    const record=await this.supplements.get(id);
    if(!Number.isInteger(revision)||revision!==record.revision)return conflict('补充内容已变化，请刷新后再提交');
    if(content.files&&!['SDK','RESOURCE','CONFIG'].includes(dependency.kind)&&!explanation)return conflict('此依赖需要直接填写数据');
    if('value' in content&&!['DATA','CONFIG'].includes(dependency.kind))return conflict('此依赖需要上传文件');
    if('value' in content){
      const errors=validateDependencyData(content.value,dependency.schema);
      if(errors.length)throw Object.assign(new Error(errors.join('；')),{statusCode:400});
      if(Buffer.byteLength(JSON.stringify(content.value))>128000)throw Object.assign(new Error('补充数据超过 128 KB'),{statusCode:400});
    }
    const saved=await this.supplements.save(id,{dependencyId,kind:dependency.kind,...content,updatedAt:new Date().toISOString()});
    diagnostic!.revision=saved.revision;
    diagnostic!.materialsDigest=this.supplements.digest(saved);
    diagnostic!.status='PARTIAL';
    dependency.provided='PENDING';
    dependency.issue='已提供，等待继续分析';
    value.candidate=null;
    value.inspection=structuredClone(value.sourceInspection!);
    value.analysis=undefined;
    await this.projects.save(value);
    return {revision:saved.revision,inspection:value.inspection};
  }
}
