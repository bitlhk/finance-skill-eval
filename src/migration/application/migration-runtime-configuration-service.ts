import {z} from 'zod';
import {validateDependencyData} from '../domain/migration-dependency-schema.js';
import {supportsImplicitScriptContext} from '../domain/migration-model.js';
import {configurationDigest} from '../domain/migration-runtime-configuration.js';
import {migrationExecutionConfig,runtimeInjection,serviceEnvironment} from '../domain/migration-runtime-rules.js';
import type {MigrationBusinessConnectionProbe} from './migration-business-connection-probe.js';
import {migrationConflict as conflict} from './migration-errors.js';
import type {MigrationProjectStore} from './migration-project-store.js';
import type {MigrationRuntimeConfigurationRepository} from './migration-runtime-configuration-repository.js';
import type {MigrationSupplementRepository} from './migration-supplement-repository.js';

export type MigrationRuntimeReference = {
  migrationId:string;
  revision:number;
  assetDigest:string;
  configurationDigest:string;
};

export class MigrationRuntimeConfigurationService {
  constructor(
    private readonly projects:MigrationProjectStore,
    private readonly runtimeConfigs:MigrationRuntimeConfigurationRepository,
    private readonly supplements:MigrationSupplementRepository,
    private readonly connectionProbe:MigrationBusinessConnectionProbe,
  ) {}

  async dependencyData(id:string,dependencyId:string){
    const value=await this.projects.get(id);
    const dependency=value.sourceInspection?.dependencyAnalysis?.dependencies.find(item=>item.id===dependencyId);
    if(!dependency||!["DATA","CONFIG"].includes(dependency.kind))return conflict("当前诊断中不存在此数据项");
    if(dependency.owner==="RUNTIME"){
      const config=await this.runtimeConfigs.get(id);
      return {provided:dependencyId in config.values,value:config.values[dependencyId]??null};
    }
    const item=(await this.supplements.get(id)).items.find(supplement=>supplement.dependencyId===dependencyId);
    return {provided:!!item,value:item?.value??null};
  }

  async runtimeConfiguration(id:string){
    const value=await this.projects.get(id);
    const config=await this.runtimeConfigs.get(id);
    const dependencies=value.sourceInspection?.dependencyAnalysis?.dependencies??[];
    return {
      revision:config.revision,
      dependencies:dependencies.filter(dependency=>dependency.owner==="RUNTIME"&&dependency.action==="INJECT").map(dependency=>{
        const implicit=supportsImplicitScriptContext(dependency);
        return {dependencyId:dependency.id,provided:implicit||dependency.id in config.values,
          valid:implicit||dependency.id in config.values&&!validateDependencyData(config.values[dependency.id],dependency.schema).length,implicit};
      }),
      checks:config.checks.map(check=>({...check,
        current:check.configurationDigest===configurationDigest(config,dependencies)
          &&check.assetDigest===(check.kind==="GENERATED_TOOL"?value.candidate??value.source:value.source).artifactSha256,
      })),
    };
  }

  async saveRuntimeDependency(id:string,dependencyId:string,input:unknown){
    return this.projects.runExclusive(id,async()=>{
      const parsed=z.strictObject({revision:z.number().int().nonnegative(),value:z.unknown()}).parse(input);
      if(!Object.prototype.hasOwnProperty.call(parsed,"value"))return conflict("请提供测试数据");
      const value=await this.projects.get(id);
      const dependency=value.sourceInspection?.dependencyAnalysis?.dependencies.find(item=>item.id===dependencyId);
      if(!dependency||dependency.owner!=="RUNTIME"||dependency.action!=="INJECT")return conflict("当前诊断没有这项可注入的运行时依赖");
      const config=await this.runtimeConfigs.save(id,dependency,parsed.value,parsed.revision);
      return {revision:config.revision};
    });
  }

  async resolveRuntimeDependencies(reference:MigrationRuntimeReference){
    const value=await this.projects.get(reference.migrationId);
    const config=await this.runtimeConfigs.get(reference.migrationId);
    const dependencies=value.sourceInspection?.dependencyAnalysis?.dependencies??[];
    if(!value.candidate||value.candidate.artifactSha256!==reference.assetDigest||config.revision!==reference.revision
      ||configurationDigest(config,dependencies)!==reference.configurationDigest)return conflict("测试运行依赖或候选已变化，请重新配置验证");
    return migrationExecutionConfig(dependencies,config.values,value.inspection?.tools??[]);
  }

  async resolveServiceEnvironment(reference:MigrationRuntimeReference,toolNames:string[]){
    const value=await this.projects.get(reference.migrationId);
    const config=await this.runtimeConfigs.get(reference.migrationId);
    const dependencies=value.sourceInspection?.dependencyAnalysis?.dependencies??[];
    if(!value.candidate||value.candidate.artifactSha256!==reference.assetDigest||config.revision!==reference.revision
      ||configurationDigest(config,dependencies)!==reference.configurationDigest)return conflict("服务配置或候选已变化，请重新验证");
    const tools=value.inspection?.tools??[];
    if(toolNames.some(name=>!tools.some(tool=>tool.name===name)))return conflict("服务配置关联了未知工具");
    const toolIds=tools.filter(tool=>toolNames.includes(tool.name)).map(tool=>tool.toolId);
    const selected=dependencies.filter(dependency=>dependency.toolIds.some(toolId=>toolIds.includes(toolId)));
    const resolved=serviceEnvironment(selected,config.values);
    const secretNames=new Set(selected.filter(dependency=>dependency.sensitive&&dependency.binding?.kind==="SERVICE_ENV")
      .map(dependency=>dependency.binding!.name));
    return {
      configuration:Object.fromEntries(Object.entries(resolved).filter(([name])=>!secretNames.has(name))),
      secrets:Object.fromEntries(Object.entries(resolved).filter(([name])=>secretNames.has(name))),
    };
  }

  async checkBusinessConnection(id:string,input:unknown,signal?:AbortSignal){
    return this.projects.runExclusive(id,async()=>{
      const parsed=z.strictObject({toolId:z.string(),endpoint:z.string().url(),method:z.enum(["GET","HEAD"]),
        confirmReadOnly:z.literal(true),revision:z.number().int().nonnegative()}).parse(input);
      const value=await this.projects.get(id),inspection=value.sourceInspection;
      if(!inspection?.tools.some(tool=>tool.toolId===parsed.toolId))return conflict("请先完成源工具诊断");
      const config=await this.runtimeConfigs.get(id);
      if(config.revision!==parsed.revision)return conflict("测试配置已变化，请刷新");
      const dependencies=inspection.dependencyAnalysis?.dependencies.filter(dependency=>dependency.toolIds.includes(parsed.toolId))??[];
      const injection=runtimeInjection(dependencies,config.values,"HTTP_HEADER");
      if(injection.missing.length)return conflict(`请先提供测试依赖：${injection.missing.join("、")}`);
      const result=await this.connectionProbe.probe(parsed.endpoint,parsed.method,injection.headers,signal);
      return this.runtimeConfigs.check(id,{...result,toolId:parsed.toolId,kind:"BUSINESS_INTERFACE",
        configurationDigest:configurationDigest(config,inspection.dependencyAnalysis?.dependencies),assetDigest:value.source.artifactSha256});
    });
  }
}
