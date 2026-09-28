import type { MigrationEnvironmentRepository } from './migration-environment-repository.js';
import { runtimeBuildRequirements } from '../domain/migration-harness.js';
import {
  migrationExecutionConfig,
  serviceEnvironment,
} from '../domain/migration-runtime-rules.js';
import { configurationDigest } from '../domain/migration-runtime-configuration.js';
import type { MigrationSkillRepository } from './migration-skill-repository.js';
import type { MigrationProjectStore } from './migration-project-store.js';
import type { MigrationEvaluationService } from './migration-evaluation-service.js';
import type { MigrationReportService } from './migration-report-service.js';
import type { MigrationTechnicalValidationWorkflow } from './migration-technical-validation-service.js';
import { migrationConflict as conflict } from './migration-errors.js';
import type { MigrationRuntimeConfigurationRepository } from './migration-runtime-configuration-repository.js';
import type { MigrationCommandResolver } from './migration-command-resolver.js';

/** Builds the OpenJiuwen launcher bindings from the inspected and generated candidate. */
export class MigrationOpenJiuwenService {
  constructor(
    private readonly projects:MigrationProjectStore,
    private readonly skills:MigrationSkillRepository,
    private readonly technicalValidation:MigrationTechnicalValidationWorkflow,
    private readonly evaluation:MigrationEvaluationService,
    private readonly reports:MigrationReportService,
    private readonly commands:MigrationCommandResolver,
    private readonly environments?:MigrationEnvironmentRepository,
    private readonly runtimeConfigs?:MigrationRuntimeConfigurationRepository,
  ) {}

  private async migrationEnvironment(environmentId:string) {
    return await this.environments?.get(environmentId)??null;
  }

  private async launcherFor(environmentId:string) {
    const selected=await this.migrationEnvironment(environmentId);
    if(selected?.type==='runtime_launcher')return selected;
    if(selected?.type==='execution_environment'){
      const launcher=await this.migrationEnvironment(selected.launcherEnvironmentId);
      return launcher?.type==='runtime_launcher'?launcher:null;
    }
    return null;
  }

  async validate(id:string,input:unknown) {
    const value=await this.projects.get(id),state=await this.technicalValidation.currentState(value);
    if(value.inspection?.skill.status!=='COMPLIANT')return conflict('OpenJiuwen 验证被阻止：当前 Skill 尚未通过企业规范检查');
    if(!state.ready)return conflict(`OpenJiuwen 验证被阻止：${state.reasons.join('；')}`);
    const body=input as {configuration?:{runtime?:{type?:string;environmentId?:string}}};
    const selectedRuntime=body?.configuration?.runtime;
    if(!selectedRuntime||selectedRuntime.type!=='runtime_launcher')return conflict('OpenJiuwen 验证必须选择 Runtime Launcher');
    const environmentId=selectedRuntime.environmentId;
    const environment=environmentId?await this.launcherFor(environmentId):null;
    if(!environment||environment.runtimeType!=='openjiuwen')return conflict('目标必须是使用 OpenJiuwen Runtime Launcher 的执行环境');
    const inspection=value.inspection!,asset=value.candidate??value.source,archive=await this.skills.readArchive(asset.assetId);
    const scripts=inspection.tools.filter(tool=>tool.kind==='SCRIPT'&&tool.entrypoint)
      .map(tool=>{const entry=tool.entrypoint!.path!.replaceAll('\\','/');let root=entry.split('/').slice(0,-1).join('/'),cursor=root;
        while(true){const prefix=cursor?`${cursor}/`:'';if(archive[`${prefix}pyproject.toml`]||archive[`${prefix}package.json`]){root=cursor;break;}if(!cursor)break;cursor=cursor.split('/').slice(0,-1).join('/');}
        const filePaths=Object.keys(archive).filter(name=>(!root||name.startsWith(`${root}/`))&&/\.(?:py|js|mjs|cjs|json|toml|lock)$/iu.test(name));
        return {name:tool.name,path:entry,kind:tool.entrypoint!.kind,filePaths,
          launch:this.commands.resolve(archive,entry,tool.entrypoint!.kind),
          ...(tool.inputSchema?{inputSchema:tool.inputSchema}:{})};});
    const services:Array<{assetDigest:string;toolNames:string[];filePaths:string[];start:string[];prepare?:string[];environmentReference?:{migrationId:string;revision:number;assetDigest:string;configurationDigest:string}}>=[];
    for(const generation of value.portableGenerations??[]){
      if(generation.form!=='MCP')continue;
      if(!generation.start?.length)return conflict(`候选 MCP ${generation.toolName} 缺少启动命令`);
      const existing=services.find(service=>JSON.stringify([service.start,service.prepare])===JSON.stringify([generation.start,generation.prepare]));
      if(existing){existing.toolNames.push(generation.toolName);existing.filePaths=[...new Set([...existing.filePaths,...generation.files])];}
      else services.push({assetDigest:asset.artifactSha256,toolNames:[generation.toolName],filePaths:generation.files,start:generation.start,...(generation.prepare?{prepare:generation.prepare}:{})});
    }
    const config=await this.runtimeConfigs!.get(id);
    const deps=value.sourceInspection?.dependencyAnalysis?.dependencies??[];
    for(const service of services){
      const toolIds=inspection.tools.filter(tool=>service.toolNames.includes(tool.name)).map(tool=>tool.toolId);
      const serviceDeps=deps.filter(dep=>dep.toolIds.some(toolId=>toolIds.includes(toolId))&&dep.binding?.kind==='SERVICE_ENV');
      serviceEnvironment(serviceDeps,config.values);
      if(serviceDeps.length)service.environmentReference={migrationId:id,revision:config.revision,assetDigest:asset.artifactSha256,configurationDigest:configurationDigest(config,deps)};
    }
    const comparison=(body.configuration as Record<string,unknown>).evaluationMode==='service_comparison';
    if(runtimeBuildRequirements(value.sourceInspection??inspection))return conflict('检测到 Runtime Harness 改造需求；自动 Runtime Builder 功能开发中，当前版本暂不能执行对比评测');
    const normalized={...(input as Record<string,unknown>),configuration:{...(body.configuration as Record<string,unknown>),runtimeCommandBindings:{left:comparison?[]:scripts,right:scripts},runtimeMcpBindings:{left:comparison?[]:services,right:services},...(deps.some(dependency=>dependency.owner==='RUNTIME'&&dependency.action==='INJECT')?{runtimeToolConfig:migrationExecutionConfig(deps,config.values,inspection.tools)}:{})}};
    return this.evaluation.validate(id,normalized);
  }

  async validations(id:string) {
    return (await this.reports.report(id)).openJiuwenValidations;
  }
}
