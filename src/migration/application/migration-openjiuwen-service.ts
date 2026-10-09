import { resolveManagedMigrationEnvironment, type MigrationEnvironmentRepository } from './migration-environment-repository.js';
import { unresolvedMigrationRuntimeRequirements } from './migration-runtime-requirements.js';
import {
  migrationExecutionConfig,
  serviceEnvironment,
} from '../domain/migration-runtime-rules.js';
import { executionConfigurationDigest as configurationDigest } from '../../execution-configuration/execution-configuration.js';
import type { MigrationSkillRepository } from './migration-skill-repository.js';
import type { MigrationProjectStore } from './migration-project-store.js';
import type { MigrationEvaluationService } from './migration-evaluation-service.js';
import type { MigrationReportService } from './migration-report-service.js';
import type { MigrationTechnicalValidationWorkflow } from './migration-technical-validation-service.js';
import { migrationConflict as conflict } from './migration-errors.js';
import type { MigrationRuntimeConfigurationRepository } from './migration-runtime-configuration-repository.js';
import type { MigrationCommandResolver } from './migration-command-resolver.js';

/** Builds managed launcher bindings; the legacy class name remains API-compatible. */
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

  async validate(id:string,input:unknown) {
    const value=await this.projects.get(id),state=await this.technicalValidation.currentState(value);
    const native=value.nativeBindings?.candidateDigest===value.candidate?.artifactSha256?value.nativeBindings:undefined;
    if(!native&&value.inspection?.skill.status!=='COMPLIANT')return conflict('Runtime 验证被阻止：当前 Skill 尚未通过企业规范检查');
    if(!native&&!state.ready)return conflict(`Runtime 验证被阻止：${state.reasons.join('；')}`);
    const body=input as {configuration?:{runtime?:{type?:string;environmentId?:string};runtimeBindings?:{left?:{environmentId?:string};right?:{environmentId?:string}}}};
    const selectedRuntime=body?.configuration?.runtime;
    if(!selectedRuntime||selectedRuntime.type!=='runtime_launcher')return conflict('Runtime 验证必须选择 Runtime Launcher');
    const environmentId=selectedRuntime.environmentId;
    const ids=new Set([environmentId,body.configuration?.runtimeBindings?.left?.environmentId,body.configuration?.runtimeBindings?.right?.environmentId].filter((id):id is string=>typeof id==='string'&&!!id));
    if(!environmentId)return conflict('目标必须是使用 OpenJiuwen 或 AgentScope Runtime Launcher 的执行环境');
    for(const id of ids){
      const resolved=await resolveManagedMigrationEnvironment(this.environments,id);
      if(!resolved)return conflict('目标必须是使用 OpenJiuwen 或 AgentScope Runtime Launcher 的执行环境');
      if(native){
        const frozen=native.bindings.targets.find(t=>t.environmentId===id);
        if(!frozen||!this.environments?.nativeToolCatalog)return conflict('此候选未绑定所选原生 Runtime');
        const current=await this.environments.nativeToolCatalog(id);
        if(current.catalog.catalogDigest!==frozen.catalogDigest)return conflict('已准入工具目录已变化，请重新绑定候选');
      }
      // Native binding has checked every declared Runtime tool against the operator-admitted catalog.
      // Other candidates still require the separate Builder delivery acceptance path.
      if(!native&&await unresolvedMigrationRuntimeRequirements(value,this.environments,resolved))return conflict('检测到 Runtime 能力缺口；请先由外部 Runtime Builder 构建并接入支持该能力的 Runtime，再执行对比评测');
    }
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
    const normalized={...(input as Record<string,unknown>),configuration:{...(body.configuration as Record<string,unknown>),runtimeCommandBindings:{left:comparison?[]:scripts,right:scripts},runtimeMcpBindings:{left:comparison?[]:services,right:services},...(deps.some(dependency=>dependency.owner==='RUNTIME'&&dependency.action==='INJECT')?{runtimeToolConfig:migrationExecutionConfig(deps,config.values,inspection.tools)}:{})}};
    return this.evaluation.validate(id,normalized);
  }

  async validations(id:string) {
    return (await this.reports.report(id)).openJiuwenValidations;
  }
}
