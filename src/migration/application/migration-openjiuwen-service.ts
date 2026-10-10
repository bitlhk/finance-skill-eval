import { resolveMigrationEnvironment,resolveManagedMigrationEnvironment, type MigrationEnvironmentRepository } from './migration-environment-repository.js';
import {unresolvedMigrationRuntimeRequirements} from './migration-runtime-requirements.js';
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
import type {MigrationProject} from '../domain/migration-project.js';
import type {MigrationExperimentContext} from './migration-evaluation-service.js';
import type {TechnicalValidation} from '../domain/migration-model.js';

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
    return this.validateProject(id,input,await this.projects.get(id));
  }

  /** Internal only: coupled tools can be validated by the frozen integrated acceptance,
   * rather than demanding a standalone call with a nonexistent opaque handle. */
  async validateReuseAcceptance(id:string,input:unknown,taskId:string,planDigest:string){
    const project=await this.projects.get(id),plan=project.reuseAcceptancePlan;
    if(!plan?.approvedAt||plan.inputDigest!==planDigest||plan.coverage.status!=='COVERED'
      ||!project.reuseAcceptanceResults?.some(task=>task.taskId===taskId&&task.planDigest===planDigest&&task.status==='RUNNING'))return conflict('缺少已确认且正在执行的复用验收');
    return this.validateProject(id,input,project,undefined,true);
  }

  async validateExperiment(id:string,input:unknown,experiment:MigrationExperimentContext,validations:TechnicalValidation[]){
    const project=await this.projects.get(id);
    return this.validateProject(id,input,{...project,candidate:experiment.candidate,
      technicalValidations:[...(project.technicalValidations??[]),...validations]},experiment);
  }

  private async validateProject(id:string,input:unknown,value:MigrationProject,experiment?:MigrationExperimentContext,integratedAcceptance=false){
    const state=await this.technicalValidation.currentState(value);
    const native=value.nativeBindings?.candidateDigest===value.candidate?.artifactSha256?value.nativeBindings:undefined;
    if(!native&&value.inspection?.skill.status!=='COMPLIANT')return conflict('OpenJiuwen 验证被阻止：当前 Skill 尚未通过企业规范检查');
    if(!native&&!state.ready&&!integratedAcceptance)return conflict(`OpenJiuwen 验证被阻止：${state.reasons.join('；')}`);
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
      if(!native&&await unresolvedMigrationRuntimeRequirements(value,this.environments,resolved))return conflict('检测到 Runtime 能力缺口；请先核对现有 Runtime 或接入 Builder 交付，再执行评测');
    }
    const inspection=value.inspection!,asset=value.candidate??value.source,archive=await this.skills.readArchive(asset.assetId);
    const scripts=inspection.tools.filter(tool=>tool.kind==='SCRIPT'&&tool.entrypoint)
      .map(tool=>{const entry=tool.entrypoint!.path!.replaceAll('\\','/');
        // Runtime must receive the same portable Skill resources used in technical
        // validation. A script directory or nearest dependency manifest is not the
        // Skill root: resources may be siblings, and need not be JSON/code files.
        const skillFile=asset.skillFile??'SKILL.md',root=skillFile.includes('/')?skillFile.slice(0,skillFile.lastIndexOf('/')+1):'';
        const filePaths=Object.keys(archive).filter(name=>name.startsWith(root));
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
    const toolConfig=migrationExecutionConfig(deps,config.values,inspection.tools);
    const configuration:Record<string,unknown>={...(body.configuration as Record<string,unknown>),runtimeCommandBindings:{left:comparison?[]:scripts,right:scripts},runtimeMcpBindings:{left:comparison?[]:services,right:services}};
    // Startup environment values already travel with the packaged MCP service.
    // Empty binding entries do not require a Runtime context/provider extension.
    // Derive this field again on retries too; do not retain the old empty config.
    if(Object.values(toolConfig.tools).some(tool=>Object.keys(tool.contextBindings).length||tool.authProvider))configuration.runtimeToolConfig=toolConfig;
    else delete configuration.runtimeToolConfig;
    const normalized={...(input as Record<string,unknown>),configuration};
    return this.evaluation.validate(id,normalized,experiment);
  }

  async validations(id:string) {
    return (await this.reports.report(id)).openJiuwenValidations;
  }
}
