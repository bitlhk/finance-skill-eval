import { createHash } from 'node:crypto';
import { z } from 'zod';
import { zipSync, strToU8 } from 'fflate';
import { fingerprint } from '../contracts.js';
import type { SkillStore } from './skill-store.js';
import type { EvaluationRunManager } from './run-manager.js';
import type { EvaluationJobStore } from './job-store.js';
import type { EvalPackCatalog } from './catalog.js';
import { runConfigurationSchema } from './contracts.js';
import type { PreparationStore } from './preparation-store.js';
import type { OptimizationManager } from './optimization-manager.js';
import { configuredModelRole } from './config.js';
import { MigrationDiagnostics } from './migration-diagnostics.js';
import { generateCandidateFiles, regenerationArchive } from './migration-candidate.js';
import type { EnvironmentStore } from './environment-store.js';
import { MigrationTargetRuns, nativeTarget } from './migration-target.js';
import {buildMigrationPlan} from './migration-model.js';
import {runtimeBuildRequirements} from './migration-harness.js';
import {MigrationRuntimeConfig,configurationDigest,migrationExecutionConfig,serviceEnvironment} from './migration-runtime-config.js';
import { analyzeWithAgent,implementWithAgent,type MigrationAnalyzer,type MigrationImplementer } from './migration-agent.js';
import {generateSuiteWithAnalyzer,type MigrationSuiteGenerator } from './migration-suite.js';
import {originalServiceFingerprint} from '../original-service-runtime.js';
import {pythonCommand} from './technical-validation.js';
import { MigrationCodeGenerator } from './migration-code-generator.js';
import { assessMigrationAcceptance } from './migration-acceptance.js';
import { MigrationProjectRepository } from '../migration/infrastructure/migration-project-repository.js';
import type { MigrationProject } from '../migration/domain/migration-project.js';
import { MigrationProjectService } from '../migration/application/migration-project-service.js';
import { MigrationInspectionService, type MigrationRuntimeReference } from '../migration/application/migration-inspection-service.js';
import { MigrationSuiteService } from '../migration/application/migration-suite-service.js';
import { MigrationCandidateService } from '../migration/application/migration-candidate-service.js';
import { MigrationGenerationService } from '../migration/application/migration-generation-service.js';
import { MigrationTechnicalValidationWorkflow } from '../migration/application/migration-technical-validation-service.js';

const planSchema = z.strictObject({
  pair:z.enum(['AB','BC','AC','SC']), configuration:runConfigurationSchema,
  dataSnapshot:z.string().min(1).max(300), permissionBasis:z.string().min(1).max(1000),
  sourceProjectRef:z.string().min(1).max(1000), dependencyLockRef:z.string().min(1).max(1000),
});
const conflict = (message:string):never => {throw Object.assign(new Error(message),{statusCode:409});};

/** Separate migration snapshots from optimization jobs. No uploaded code is executed here. */
export class MigrationStore {
  private readonly projects: MigrationProjectRepository;
  private readonly projectService: MigrationProjectService;
  private readonly inspectionService: MigrationInspectionService;
  private readonly suiteService: MigrationSuiteService;
  private readonly candidateService: MigrationCandidateService;
  private readonly generationService: MigrationGenerationService;
  private readonly technicalValidation: MigrationTechnicalValidationWorkflow;
  constructor(private root:string, private skills:SkillStore, private runs:EvaluationRunManager,
    private jobs:EvaluationJobStore, private catalog:EvalPackCatalog, private preparations?:PreparationStore,
    private optimizers?:OptimizationManager, private diagnostics?:MigrationDiagnostics, private environments?:EnvironmentStore,
    private codeGenerator=new MigrationCodeGenerator(()=>configuredModelRole('MIGRATION')),
    analyzer:MigrationAnalyzer=(input,)=>analyzeWithAgent(input,{projectRoot:process.env.FINANCE_EVAL_ROOT?.trim()||process.cwd(),
      modelId:process.env.FINANCE_EVAL_AGENT_MODEL_ID?.trim()||'enterprise-model'}),
    private implementer:MigrationImplementer=(input,)=>implementWithAgent(input,{projectRoot:process.env.FINANCE_EVAL_ROOT?.trim()||process.cwd(),
      modelId:process.env.FINANCE_EVAL_AGENT_MODEL_ID?.trim()||'enterprise-model'}),
    suiteGenerator:MigrationSuiteGenerator=(input,)=>generateSuiteWithAnalyzer(input,()=>configuredModelRole('ANALYZER')),
    projects?: MigrationProjectRepository) {
    this.projects = projects ?? new MigrationProjectRepository(root);
    this.projectService = new MigrationProjectService(this.projects, skills, diagnostics);
    this.inspectionService = new MigrationInspectionService(root, this.projects, skills, analyzer);
    this.suiteService = new MigrationSuiteService(this.projects, skills, analyzer, suiteGenerator, preparations);
    this.candidateService = new MigrationCandidateService(this.projects, skills, diagnostics);
    this.generationService = new MigrationGenerationService(root, this.projects, skills, implementer, codeGenerator, diagnostics);
    this.technicalValidation = new MigrationTechnicalValidationWorkflow(root, this.projects, skills);
  }
  private async migrationEnvironment(environmentId:string){
    return await this.environments?.get(environmentId)??null;
  }
  async target(){try{return {available:true,target:await nativeTarget()};}catch{return {available:false,message:'目标 Host 未就绪或模型连接不可用，请联系维护者。'};}}
  async verifyTarget(id:string,input:unknown){return this.serial(id,async()=>{
    const p=z.strictObject({baseAssetId:z.string()}).parse(input),value=await this.get(id);
    if(!value.candidate||p.baseAssetId!==value.candidate.assetId)return conflict('候选已变化，请刷新后验证');
    if(!value.simulationProfile||value.generation?.candidateDigest!==value.candidate.artifactSha256)return conflict('请先审阅映射并生成当前候选；修改后需重新审阅');
    const runner=new MigrationTargetRuns(this.root,this.skills);
    for(const runId of value.targetRuns??[])if((await runner.get(runId)).status==='RUNNING')return conflict('当前项目已有验证正在运行');
    const run=await runner.start(value.candidate,value.simulationProfile);(value.targetRuns??=[]).push(run.id);await this.projects.save(value);return run;
  });}
  private serial<T>(id:string,fn:()=>Promise<T>):Promise<T> {
    return this.projects.runExclusive(id,fn);
  }
  async list() {return this.projectService.list();}
  async get(id:string):Promise<MigrationProject> {return this.projectService.get(id);}
  async create(input:unknown) {return this.projectService.create(input);}
  async upgrade(id:string){return this.projectService.upgrade(id);}
  async diagnose(id:string,retry=false){return this.projectService.diagnose(id,retry);}
  async inspect(id:string,sourceOnly=false){return this.inspectionService.inspect(id,sourceOnly);}
  async dependencyData(id:string,dependencyId:string){
    return this.inspectionService.dependencyData(id,dependencyId);
  }
  async runtimeConfiguration(id:string){
    return this.inspectionService.runtimeConfiguration(id);
  }
  async saveRuntimeDependency(id:string,dependencyId:string,input:unknown){return this.inspectionService.saveRuntimeDependency(id,dependencyId,input);}
  async resolveRuntimeDependencies(reference:MigrationRuntimeReference){return this.inspectionService.resolveRuntimeDependencies(reference);}
  async resolveServiceEnvironment(reference:MigrationRuntimeReference,toolNames:string[]){return this.inspectionService.resolveServiceEnvironment(reference,toolNames);}
  async checkBusinessConnection(id:string,input:unknown,signal?:AbortSignal){return this.inspectionService.checkBusinessConnection(id,input,signal);}
  async supplementDependency(id:string,dependencyId:string,input:unknown){return this.inspectionService.supplementDependency(id,dependencyId,input);}
  async uploadDependency(id:string,dependencyId:string,revision:number,filename:string,bytes:Buffer){return this.inspectionService.uploadDependency(id,dependencyId,revision,filename,bytes);}
  async explainDependency(id:string,dependencyId:string,input:unknown){return this.inspectionService.explainDependency(id,dependencyId,input);}
  async inspection(id:string){return this.inspectionService.inspection(id);}
  async decide(id:string,toolId:string,input:unknown){return this.inspectionService.decide(id,toolId,input);}
  async plan(id:string){return this.inspectionService.plan(id);}
  async runtimeRequirements(id:string){return this.inspectionService.runtimeRequirements(id);}
  async runtimeRequirementsYaml(id:string){return this.inspectionService.runtimeRequirementsYaml(id);}
  private async generatePortable(id:string,input:unknown){return this.generationService.generate(id,input);}
  async validateTechnical(id:string,input:unknown,signal?:AbortSignal){return this.technicalValidation.validate(id,input,signal);}
  async technicalValidations(id:string){return this.technicalValidation.list(id);}
  private async currentTechnicalState(value:MigrationProject){return this.technicalValidation.currentState(value);}
  async validateOpenJiuwen(id:string,input:unknown){
    const value=await this.get(id),state=await this.currentTechnicalState(value);
    if(value.inspection?.skill.status!=='COMPLIANT')return conflict('OpenJiuwen 验证被阻止：当前 Skill 尚未通过企业规范检查');
    if(!state.ready)return conflict(`OpenJiuwen 验证被阻止：${state.reasons.join('；')}`);
    const body=input as {configuration?:{runtime?:{type?:string;environmentId?:string}}};
    const selectedRuntime=body?.configuration?.runtime;
    if(!selectedRuntime||selectedRuntime.type!=='runtime_launcher')return conflict('OpenJiuwen 验证必须选择 Runtime Launcher');
    const environmentId=selectedRuntime.environmentId;
    const environment=environmentId?await this.migrationEnvironment(environmentId):null;
    if(!environment||environment.type!=='runtime_launcher'||environment.runtimeType!=='openjiuwen')return conflict('目标必须是已配置的 OpenJiuwen Runtime Launcher');
    const inspection=value.inspection!,asset=value.candidate??value.source,archive=await this.skills.readArchive(asset.assetId);
    const scripts=inspection.tools.filter(tool=>tool.kind==='SCRIPT'&&tool.entrypoint)
      .map(tool=>{const entry=tool.entrypoint!.path!.replaceAll('\\','/');let root=entry.split('/').slice(0,-1).join('/'),cursor=root;
        while(true){const prefix=cursor?`${cursor}/`:'';if(archive[`${prefix}pyproject.toml`]||archive[`${prefix}package.json`]){root=cursor;break;}if(!cursor)break;cursor=cursor.split('/').slice(0,-1).join('/');}
        const filePaths=Object.keys(archive).filter(name=>(!root||name.startsWith(`${root}/`))&&/\.(?:py|js|mjs|cjs|json|toml|lock)$/iu.test(name));
        return {name:tool.name,path:entry,kind:tool.entrypoint!.kind,filePaths,
          launch:tool.entrypoint!.kind==='PYTHON'?pythonCommand(archive,entry):{program:'node',args:[entry]},
          ...(tool.inputSchema?{inputSchema:tool.inputSchema}:{})};});
    const services:Array<{assetDigest:string;toolNames:string[];filePaths:string[];start:string[];prepare?:string[];environmentReference?:{migrationId:string;revision:number;assetDigest:string;configurationDigest:string}}>=[];
    for(const generation of value.portableGenerations??[]){
      if(generation.form!=='MCP')continue;
      if(!generation.start?.length)return conflict(`候选 MCP ${generation.toolName} 缺少启动命令`);
      const existing=services.find(service=>JSON.stringify([service.start,service.prepare])===JSON.stringify([generation.start,generation.prepare]));
      if(existing){existing.toolNames.push(generation.toolName);existing.filePaths=[...new Set([...existing.filePaths,...generation.files])];}
      else services.push({assetDigest:asset.artifactSha256,toolNames:[generation.toolName],filePaths:generation.files,start:generation.start,...(generation.prepare?{prepare:generation.prepare}:{})});
    }
    const config=await new MigrationRuntimeConfig(this.root).get(id);
    const deps=value.sourceInspection?.dependencyAnalysis?.dependencies??[];
    for(const service of services){
      const toolIds=inspection.tools.filter(tool=>service.toolNames.includes(tool.name)).map(tool=>tool.toolId);
      const serviceDeps=deps.filter(dep=>dep.toolIds.some(id=>toolIds.includes(id))&&dep.binding?.kind==='SERVICE_ENV');
      serviceEnvironment(serviceDeps,config.values);
      if(serviceDeps.length)service.environmentReference={migrationId:id,revision:config.revision,assetDigest:asset.artifactSha256,configurationDigest:configurationDigest(config,deps)};
    }
    const comparison=(body.configuration as Record<string,unknown>).evaluationMode==='service_comparison';
    if(runtimeBuildRequirements(value.sourceInspection??inspection))return conflict('检测到 Runtime Harness 改造需求；自动 Runtime Builder 功能开发中，当前版本暂不能执行对比评测');
    const normalized={...(input as Record<string,unknown>),configuration:{...(body.configuration as Record<string,unknown>),runtimeCommandBindings:{left:comparison?[]:scripts,right:scripts},runtimeMcpBindings:{left:comparison?[]:services,right:services},...(deps.some(d=>d.owner==='RUNTIME'&&d.action==='INJECT')?{runtimeToolConfig:migrationExecutionConfig(deps,config.values,inspection.tools)}:{})}};
    return this.validate(id,normalized);
  }
  async openJiuwenValidations(id:string){
    return (await this.report(id)).openJiuwenValidations;
  }
  async generate(id:string,input:unknown){
    if(input&&typeof input==='object'&&'runtime' in input)return this.generateLegacy(id,input);
    return this.generatePortable(id,input);
  }
  private async generateLegacy(id:string,input:unknown){return this.serial(id,async()=>{
    const p=z.strictObject({runtime:z.enum(['openjiuwen']),environmentId:z.string().optional(),
      intent:z.enum(['portable_method_and_adapters','preserve_business_method']),baseAssetId:z.string(),simulationProfile:z.string().optional(),acknowledgeSimulation:z.literal(true).optional()}).parse(input);
    const value=await this.get(id);
    if(p.baseAssetId!==(value.candidate??value.source).assetId)return conflict('候选已变化，请刷新后重新生成');
    if(p.environmentId){const env=await this.migrationEnvironment(p.environmentId);
      if(!env||env.type!=='runtime_launcher'||env.runtimeType!=='openjiuwen')return conflict('目标必须是已配置的 OpenJiuwen Runtime Launcher');}
    const base=value.candidate??value.source;
    const originalArchive=await this.skills.readArchive(base.assetId);
    if(value.generation)for(const [name,bytes] of Object.entries(originalArchive).filter(([name])=>name.startsWith('migration-generated/'))){
      const expected=value.generation.diff.find(d=>d.path===name)?.after;
      if(expected===undefined||Buffer.from(bytes).toString()!==expected)return conflict('适配生成文件已修改；为避免覆盖工程改动，请先人工处理冲突');
    }
    const archive=regenerationArchive(originalArchive,base);
    const diagnosis=this.diagnostics?await this.diagnostics.diagnose(base):await this.diagnose(id);
    const version=`0.1.0-migration.${(value.candidateHistory?.length??0)+1}`;
    const target={runtime:p.runtime,...(p.environmentId?{environmentId:p.environmentId}:{}),intent:p.intent};
    if(p.simulationProfile&&!p.acknowledgeSimulation)return conflict('请确认模拟端口、资源映射与业务待确认边界');
    const simulation=p.simulationProfile?{id:p.simulationProfile,target:await nativeTarget()}:undefined;
    const generated=generateCandidateFiles(archive,base,diagnosis,version,target,simulation);
    const candidate=await this.skills.uploadZip(Buffer.from(zipSync(generated.files)));
    // The legacy request shape intentionally enters the 0.1 workflow. Keeping
    // that identity prevents its simulated target evidence from being mistaken
    // for a 2.0 OpenJiuwen validation.
    value.schemaVersion='finance.skill-migration.v0.1';
    value.candidate=candidate;value.candidateNotes='基于当前版本生成声明与薄适配；保留方法修改和资源，等待本版本验证。';
    value.simulationProfile=p.simulationProfile;
    value.generation={candidateDigest:candidate.artifactSha256,target,diff:generated.diff,generatedAt:new Date().toISOString()};
    (value.candidateHistory??=[]).push({asset:candidate,notes:value.candidateNotes,recordedAt:new Date().toISOString(),kind:'migration'});
    await this.projects.save(value);return value;
  });}
  async candidate(id:string,input:unknown) {return this.candidateService.import(id,input);}
  async draft(id:string,input:unknown) {return this.candidateService.saveDraft(id,input);}
  async analyze(id:string) {return this.candidateService.analyze(id);}
  async review(id:string,input:unknown){return this.candidateService.review(id,input);}
  async createSuite(id:string,input:unknown) {return this.suiteService.create(id,input);}
  async importSimpleSuite(id:string,input:unknown){return this.suiteService.importSimple(id,input);}
  async generateSuite(id:string,input:unknown) {return this.suiteService.generate(id,input);}
  async optimize(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=z.strictObject({jobId:z.string().min(1)}).parse(input),value=await this.get(id);
    if (!this.optimizers || !value.candidate) return conflict('优化器或候选不可用');
    if(value.generation)return conflict('生成候选需先完成原生迁移验证；当前 Host 适配验收尚未完成，暂不进入表达优化');
    const experiment=value.runs.find(r=>r.jobId===p.jobId);
    if (!experiment || experiment.candidateDigest!==value.candidate.artifactSha256) return conflict('请为当前候选选择一次运行记录');
    if(value.schemaVersion==='finance.skill-migration.v2'){
      const technical=await this.currentTechnicalState(value);if(!technical.ready)return conflict(`请先完成当前 Tool 技术验证：${technical.reasons.join('；')}`);
      const selectedRuntime=experiment.declaredPlan?.configuration.runtime;
      const environmentId=selectedRuntime?.type==='runtime_launcher'?selectedRuntime.environmentId:null;
      const environment=environmentId?await this.migrationEnvironment(environmentId):null;
      if(!environment||environment.runtimeType!=='openjiuwen')return conflict('请先完成当前候选的本地 OpenJiuwen 评估');
    }
    if(value.sourceInspection?.dependencyAnalysis?.dependencies.some(d=>d.owner==='RUNTIME'&&d.action==='INJECT')&&experiment.runtimeConfigurationDigest!==configurationDigest(await new MigrationRuntimeConfig(this.root).get(id),value.sourceInspection.dependencyAnalysis.dependencies))return conflict('运行配置已变化，请重新评估后再优化');
    const job=this.jobs.get(p.jobId),variant=job?.report?.variants.right;
    if (variant?.mode!=='skill_version' || variant.artifactSha256!==value.candidate.artifactSha256) return conflict('缺少已完成的右侧候选运行证据');
    const item=await this.optimizers.create(p.jobId);
    (value.optimizations??=[]).push({optimizationId:item.optimizationId,sourceJobId:p.jobId,baseAssetId:value.candidate.assetId,candidateDigest:value.candidate.artifactSha256});
    await this.projects.save(value);return item;
  });}
  async adoptOptimization(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=z.strictObject({optimizationId:z.string().min(1)}).parse(input),value=await this.get(id);
    const link=value.optimizations?.find(o=>o.optimizationId===p.optimizationId);
    if (!link || !this.optimizers || value.candidate?.assetId!==link.baseAssetId) return conflict('这次优化与当前候选无关，或它的基线候选已变化');
    const item=await this.optimizers.get(p.optimizationId);
    if (!item.candidate || !['review','adopted'].includes(item.status)) return conflict('优化候选必须先跑完复测才能采用');
    await this.skills.readArchive(item.candidate.assetId);
    value.candidate=item.candidate;value.candidateNotes=`Optimization ${item.optimizationId}: ${item.summary}`;
    (value.candidateHistory??=[]).push({asset:item.candidate,notes:value.candidateNotes,recordedAt:new Date().toISOString(),kind:'optimization'});
    // Adoption is a local candidate choice, not migration or business acceptance.
    await this.projects.save(value);return value;
  });}
  async validate(id:string,input:unknown) {return this.serial(id,async()=>{
    const p=planSchema.parse(input), value=await this.get(id), c=value.candidate;
    if (!c || !p.configuration.runtimeBindings) return conflict('缺少候选或左右两侧的绑定');
    if(p.configuration.runtime.type!=='runtime_launcher')return conflict('Skill 迁移评测必须使用 Runtime Launcher');
    const launcherEnvironmentId=p.configuration.runtime.environmentId;
    if((['left','right'] as const).some(side=>p.configuration.runtimeBindings![side].environmentId!==launcherEnvironmentId))return conflict('左右执行绑定必须属于所选 Runtime Launcher');
    let pack=p.configuration.packId ? this.catalog.get(p.configuration.packId):null;
    if (p.configuration.preparationId) {
      if (!value.suiteIds?.includes(p.configuration.preparationId)) return conflict('请选择属于本次迁移的冻结测试集');
      const preparation=await this.preparations?.get(p.configuration.preparationId);
      if (preparation) pack=this.preparations!.buildPack({preparation,analyzerModel:configuredModelRole('ANALYZER').model,
        executionModel:p.configuration.executionModel!,judgeModel:configuredModelRole('JUDGE').model});
    }
    if (!pack || p.configuration.includeHoldout) return conflict('请选择一个冻结的开发题集；留出题留给独立复评');
    const serviceComparison=p.pair==='SC'&&p.configuration.evaluationMode==='service_comparison';
    if((p.pair==='SC')!==(p.configuration.evaluationMode==='service_comparison'))return conflict('原服务对比必须使用 SC 对比计划');
    if(pack.metadata.assessmentMode==='natural_language'&&(!(serviceComparison||(p.pair==='BC'&&p.configuration.evaluationMode==='candidate_assessment'))||p.configuration.judgeMode!=='model'))return conflict('自然语言测试集仅用于目标评估或原服务对比');
    if(serviceComparison&&pack.metadata.assessmentMode!=='natural_language')return conflict('原服务对比请选择包含任务输入和验收要求的测试集');
    if(pack.metadata.comparisonOnly==='true'&&!serviceComparison)return conflict('这份测试集以原服务为基线，请选择原服务对比；目标评估需另外提供独立验收要求');
    const expected=p.pair==='AB' ? [value.source,c] : p.pair==='BC' ? [c,c] : [value.source,c];
    for (const [index,side] of (['left','right'] as const).entries()) {
      const binding=p.configuration.runtimeBindings[side], variant=p.configuration[side==='left'?'leftVariant':'rightVariant'];
      const asset=expected[index]!;
      if (binding.skillAssetId!==asset.assetId || variant?.mode!=='skill_version' || variant.artifactSha256!==asset.artifactSha256
          || variant.skillId!==asset.skillId || variant.version!==asset.version) return conflict('左右绑定与冻结的源/候选不一致');
    }
    if(p.pair==='BC'&&p.configuration.evaluationMode!=='candidate_assessment')return conflict('BC 是对迁移候选的质量评估，不是左右胜负比较');
    if (p.pair==='AB' && p.configuration.runtimeBindings.left.environmentId!==p.configuration.runtimeBindings.right.environmentId) return conflict('AB 对照必须保持原 Runtime 环境一致');
    const runtimeConfigurationDigest=configurationDigest(await new MigrationRuntimeConfig(this.root).get(id),value.sourceInspection?.dependencyAnalysis?.dependencies);
    const comparisonFingerprint=fingerprint({runtimeConfigurationDigest,pack:pack.packFingerprint, model:p.configuration.executionModel,
      cases:p.configuration.selectedCaseIds, data:p.dataSnapshot, permissions:p.permissionBasis,
      sourceProject:p.sourceProjectRef, lock:p.dependencyLockRef,evaluationMode:p.configuration.evaluationMode,
      ...(p.configuration.originalService?{originalService:originalServiceFingerprint(p.configuration.originalService)}:{})});
    const job=await this.runs.create(p.configuration);
    value.runs.push({jobId:job.jobId,pair:p.pair,candidateDigest:c.artifactSha256,comparisonFingerprint,packFingerprint:pack.packFingerprint,declaredPlan:p,suiteSnapshot:pack,runtimeConfigurationDigest});
    await this.projects.save(value);
    return {job,comparisonFingerprint,acceptance:'NOT_VALIDATED',note:'Runs are experiments; declared environment/material references are not native-runtime or authorization attestation.'};
  });}
  async report(id:string) {
    const value=await this.get(id);
    const runtimeInspection=value.sourceInspection??value.inspection;
    const runtimeRequirements=runtimeInspection?runtimeBuildRequirements(runtimeInspection):null;
    const diagnosis=this.diagnostics?await this.diagnostics.diagnose(value.source):null;
    const targetRunner=new MigrationTargetRuns(this.root,this.skills);
    const targetRuns=await Promise.all((value.targetRuns??[]).map(runId=>targetRunner.get(runId)));
    const current=targetRuns.filter(r=>r.candidateDigest===value.candidate?.artifactSha256).at(-1);
    const currentAsset=value.candidate??value.source;
    const runtimeDigest=configurationDigest(await new MigrationRuntimeConfig(this.root).get(id),value.sourceInspection?.dependencyAnalysis?.dependencies);
    const technicalValidations=(value.technicalValidations??[]).map(result=>({...result,current:result.assetDigest===currentAsset.artifactSha256&&(!result.runtimeConfigurationDigest||result.runtimeConfigurationDigest===runtimeDigest)}));
    const migrationPlan=value.inspection?buildMigrationPlan(value.inspection,value.decisions??[],value.inspection.assetId):null;
    const experiments=value.runs.map(r=>{
      const job=this.jobs.get(r.jobId);
      const complete=job?.status==='completed' && !!job.report?.cases.length && job.report.cases.every(c=>(['left','right'] as const).every(side=>{
        if(side==='left'&&r.declaredPlan?.configuration.evaluationMode==='service_comparison'){
          const service=c.left.metadata.baselineService as {configurationFingerprint?:string;sourceDigest?:string;responseDigest?:string}|undefined;
          return c.left.status==='completed'&&c.left.streamCompleted&&service?.sourceDigest===value.source.artifactSha256
            &&!!service.responseDigest&&service.configurationFingerprint===originalServiceFingerprint(r.declaredPlan.configuration.originalService!);
        }
        const variant=job.configuration[side==='left'?'leftVariant':'rightVariant'];
        return c[side].status==='completed' && variant?.mode==='skill_version' && !!variant.artifactSha256
          && c[side].metadata.skillArtifactSha256===variant.artifactSha256;
      }));
      const selected=r.declaredPlan?.configuration.selectedCaseIds??[];
      const acceptance=assessMigrationAcceptance(job?.report??null,(r.suiteSnapshot?.cases??[]).filter(item=>!selected.length||selected.includes(item.caseId)),complete);
      return {...r,current:r.candidateDigest===currentAsset.artifactSha256&&(!value.sourceInspection?.dependencyAnalysis?.dependencies.some(d=>d.owner==='RUNTIME'&&d.action==='INJECT')||r.runtimeConfigurationDigest===runtimeDigest),execution:job?.status??'MISSING',createdAt:job?.createdAt,updatedAt:job?.updatedAt,report:job?.report??null,error:job?.error??null,evidence:complete?(r.pair==='SC'?'SERVICE_BASELINE_AND_CANDIDATE_DIGEST_CHECKED':'HTTP_LOADED_DIGEST_CHECKED'):'NOT_COMPLETE',acceptance,
        taskSuccess:'NOT_INDEPENDENTLY_VERIFIED',professionalAcceptance:'NOT_REVIEWED',migrationAcceptance:'NOT_VALIDATED'};
    });
    const openJiuwenValidations=(await Promise.all(experiments.map(async experiment=>{
      const runtime=experiment.declaredPlan?.configuration.runtime;
      const environment=runtime&&(runtime.type==='runtime_http'||runtime.type==='runtime_launcher')?await this.migrationEnvironment(runtime.environmentId):null;
      if(!environment||!['runtime_http','runtime_launcher'].includes(environment.type)||environment.runtimeType!=='openjiuwen')return null;
      return {jobId:experiment.jobId,candidateDigest:experiment.candidateDigest,environmentId:environment.environmentId,
        execution:experiment.execution,evidence:experiment.evidence,current:experiment.current,
        executionCheck:['HTTP_LOADED_DIGEST_CHECKED','SERVICE_BASELINE_AND_CANDIDATE_DIGEST_CHECKED'].includes(experiment.evidence)?'ARTIFACT_VERIFIED':experiment.execution==='completed'?'EXECUTION_COMPLETED':'NOT_COMPLETE',
        acceptance:experiment.acceptance,
        status:experiment.execution==='completed'?experiment.acceptance.status:experiment.execution==='failed'?'FAILED':['queued','preparing','running','judging'].includes(experiment.execution)?'RUNNING':'NOT_VALIDATED'};
    }))).filter(item=>item!==null);
    const currentOpenJiuwen=openJiuwenValidations.filter(item=>item.current).at(-1);
    const targetExecution=value.schemaVersion==='finance.skill-migration.v2'?(currentOpenJiuwen?.status??'NOT_RUN'):(current?.status??'NOT_RUN');
    const originalBaseline=experiments.filter(r=>r.pair==='SC'&&r.current).at(-1);
    return {project:value,diagnosis,inspection:value.inspection??null,decisions:value.decisions??[],migrationPlan,runtimeRequirements,portableGenerationDiff:value.portableGenerationDiff??[],technicalValidations,openJiuwenValidations,targetRuns,professionalReview:value.reviews?.filter(r=>r.candidateDigest===value.candidate?.artifactSha256).at(-1)??null,verification:{originalBaseline:originalBaseline?.evidence==='SERVICE_BASELINE_AND_CANDIDATE_DIGEST_CHECKED'?'CAPTURED':originalBaseline?'NOT_COMPLETE':'NOT_RUN',targetExecution,
      candidateChanged:!!value.generation&&value.generation.candidateDigest!==value.candidate?.artifactSha256,
      originalOwner:'原工程负责人',targetOwner:'Harness / Host 接入开发者',
      missingSource:diagnosis?.findings.filter(f=>f.layer==='UNKNOWN').map(f=>({path:f.path,line:f.line,reason:f.reason}))??[],
      targetGaps:value.simulationProfile?['本目标只验证方法在模拟业务端口上的执行，不证明原环境等价或专业结论正确。','原工程、原环境对照与业务口径仍待负责人确认。']:[targetExecution==='PASSED'?'当前候选通过自动验收，但原环境对照与人类专业签署尚未完成':'当前候选尚未通过完整业务验收，请查看工具调用证据、必备规则和质量评分',
        '需冻结等价测试数据与可信身份范围；配置声明不等于授权已核验']},
      suites:await Promise.all((value.suiteIds??[]).map(id=>this.preparations?.get(id)??null)),
      optimizations:await Promise.all((value.optimizations??[]).map(async link=>({...link,item:await this.optimizers?.get(link.optimizationId)}))),
      experiments, attribution:'BC compares target execution stacks, including Harness; not a pure Runtime effect.'};
  }
  async exportCandidate(id:string) {
    const value=await this.get(id);
    if (!value.candidate) return conflict('请先生成候选');
    const files=await this.skills.readArchive(value.candidate.assetId);
    if (['migration-manifest.json','migration-report.json'].some(name=>name in files)) return conflict('候选里已存在导出要用的元数据路径，未覆盖任何文件');
    const report=await this.report(id);
    for(const [name,bytes] of Object.entries(files)){
      if(/(^|\/)(\.env(?:\..*)?|access-token|id_rsa|id_ed25519)$|\.(pem|key)$/i.test(name)||/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\n]{8,}["']/i.test(Buffer.from(bytes).toString()))
        return conflict('候选可能包含凭据，请先检查并移除敏感配置；未导出任何文件');
    }
    // V2 exports are the standard Skill/Tool delivery itself. Migration evidence
    // remains available from /report and must not pollute the specified package.
    if(value.schemaVersion==='finance.skill-migration.v2')return Buffer.from(zipSync(files));
    const state=report.verification.targetExecution==='PASSED'?'TARGET_VERIFIED_CANDIDATE':'DRAFT_NOT_VALIDATED';
    const manifest={schemaVersion:'finance.skill-migration.exchange.v0.1',projectId:id,source:value.source,candidate:value.candidate,
      state,builderImport:'NOT_VERIFIED',installationLock:'ASSEMBLER_RESPONSIBILITY',
      executionPolicy:'INERT_ARCHIVE_ONLY_NO_SCRIPT_EXECUTION',dependencies:'NOT_VALIDATED',
      fileDigestAlgorithm:'SHA-256 of original file bytes',
      files:Object.fromEntries(Object.entries(files).map(([name,content])=>[name,createHash('sha256').update(content).digest('hex')]))};
    return Buffer.from(zipSync({...files,'migration-manifest.json':strToU8(JSON.stringify(manifest,null,2)),
      'migration-report.json':strToU8(JSON.stringify({schemaVersion:'migration.export-scope.v1',state,
        candidateDigest:value.candidate.artifactSha256,inspection:report.inspection,decisions:report.decisions,migrationPlan:report.migrationPlan,
        technicalValidations:report.technicalValidations.map(v=>({validationId:v.validationId,toolId:v.toolId,assetDigest:v.assetDigest,implementationDigest:v.implementationDigest,casesDigest:v.casesDigest,mode:v.mode,status:v.status,stages:v.stages,current:v.current})),openJiuwenValidations:report.openJiuwenValidations,verification:report.verification,
        changes:(value.portableGenerationDiff??value.generation?.diff??[]).map(d=>({path:d.path,operation:d.operation})),
        targetRuns:report.targetRuns.map(r=>({id:r.id,candidateDigest:r.candidateDigest,status:r.status,
          cases:r.cases.map(c=>({caseId:c.caseId,passed:c.passed}))})),
        professionalAcceptance:report.professionalReview?'ADMIN_RECORDED_NOT_INDEPENDENTLY_VERIFIED':'NOT_REVIEWED',
        professionalReview:report.professionalReview?{decision:report.professionalReview.decision,source:report.professionalReview.source,recordedAt:report.professionalReview.recordedAt}:null,
        originalEquivalence:'NOT_VERIFIED',
        excluded:'No raw model answers, test payloads, connection configuration or complete experiment reports. Review your own method/resource files for private content before sharing.'},null,2))}));
  }
  release():never {return conflict('发布已阻止：原环境基线、目标 Host 接入、依赖验证与独立业务验收都还没有验证');}
}
