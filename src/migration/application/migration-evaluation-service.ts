import { z } from 'zod';
import { fingerprint } from '../../contracts.js';
import { originalServiceFingerprint } from '../../original-service-runtime.js';
import type { EvalPackCatalog } from '../../service/catalog.js';
import { configuredModelRole } from '../../service/config.js';
import { runConfigurationSchema } from '../../service/contracts.js';
import type { EnvironmentStore } from '../../service/environment-store.js';
import type { EvaluationJobStore } from '../../service/job-store.js';
import { assessMigrationAcceptance } from '../domain/migration-acceptance.js';
import type { MigrationDiagnostics } from '../../service/migration-diagnostics.js';
import { runtimeBuildRequirements } from '../../service/migration-harness.js';
import { buildMigrationPlan } from '../domain/migration-model.js';
import { MigrationRuntimeConfig, configurationDigest } from '../infrastructure/migration-runtime-config.js';
import { MigrationTargetRuns } from '../infrastructure/migration-target.js';
import type { OptimizationManager } from '../../service/optimization-manager.js';
import type { PreparationStore } from '../../service/preparation-store.js';
import type { EvaluationRunManager } from '../../service/run-manager.js';
import type { SkillStore } from '../../service/skill-store.js';
import type { MigrationProjectRepository } from '../infrastructure/migration-project-repository.js';
import { migrationConflict as conflict } from './migration-errors.js';

const planSchema = z.strictObject({
  pair:z.enum(['AB','BC','AC','SC']), configuration:runConfigurationSchema,
  dataSnapshot:z.string().min(1).max(300), permissionBasis:z.string().min(1).max(1000),
  sourceProjectRef:z.string().min(1).max(1000), dependencyLockRef:z.string().min(1).max(1000),
});

export class MigrationEvaluationService {
  constructor(
    private readonly root:string,
    private readonly projects:MigrationProjectRepository,
    private readonly skills:SkillStore,
    private readonly runs:EvaluationRunManager,
    private readonly jobs:EvaluationJobStore,
    private readonly catalog:EvalPackCatalog,
    private readonly preparations?:PreparationStore,
    private readonly optimizers?:OptimizationManager,
    private readonly diagnostics?:MigrationDiagnostics,
    private readonly environments?:EnvironmentStore,
  ) {}

  private async migrationEnvironment(environmentId:string) {
    return await this.environments?.get(environmentId)??null;
  }

  async validate(id:string,input:unknown) {
    return this.projects.runExclusive(id,async()=>{
      const p=planSchema.parse(input), value=await this.projects.get(id), c=value.candidate;
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
    });
  }

  async report(id:string) {
    const value=await this.projects.get(id);
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
      suites:await Promise.all((value.suiteIds??[]).map(suiteId=>this.preparations?.get(suiteId)??null)),
      optimizations:await Promise.all((value.optimizations??[]).map(async link=>({...link,item:await this.optimizers?.get(link.optimizationId)}))),
      experiments, attribution:'BC compares target execution stacks, including Harness; not a pure Runtime effect.'};
  }
}
