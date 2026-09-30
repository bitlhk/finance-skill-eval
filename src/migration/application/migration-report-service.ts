import { originalServiceFingerprint } from '../../original-service-runtime.js';
import type { MigrationEvaluationJobReader } from './migration-evaluation-ports.js';
import { resolveManagedMigrationEnvironment, type MigrationEnvironmentRepository } from './migration-environment-repository.js';
import type { MigrationOptimizationPort } from './migration-optimization-port.js';
import type { MigrationPreparationRepository } from './migration-preparation-repository.js';
import type { MigrationProjectStore } from './migration-project-store.js';
import type { MigrationRuntimeConfigurationRepository } from './migration-runtime-configuration-repository.js';
import type { MigrationDiagnosisPort } from './migration-diagnosis-port.js';
import { assessMigrationAcceptance } from '../domain/migration-acceptance.js';
import { unresolvedMigrationRuntimeRequirements } from './migration-runtime-requirements.js';
import { buildMigrationPlan } from '../domain/migration-model.js';
import { executionConfigurationDigest as configurationDigest } from '../../execution-configuration/execution-configuration.js';
import { migrationWorkflow } from '../domain/migration-workflow.js';

/** Builds the read model consumed by migration reporting, export and target validation views. */
export class MigrationReportService {
  constructor(
    private readonly projects:MigrationProjectStore,
    private readonly jobs:MigrationEvaluationJobReader,
    private readonly preparations?:MigrationPreparationRepository,
    private readonly optimizers?:MigrationOptimizationPort,
    private readonly diagnostics?:MigrationDiagnosisPort,
    private readonly environments?:MigrationEnvironmentRepository,
    private readonly runtimeConfigs?:MigrationRuntimeConfigurationRepository,
  ) {}

  async report(id:string) {
    const value=await this.projects.get(id);
    const runtimeRequirements=await unresolvedMigrationRuntimeRequirements(value,this.environments);
    const diagnosis=this.diagnostics?await this.diagnostics.diagnose(value.source):null;
    const currentAsset=value.candidate??value.source;
    const runtimeDigest=configurationDigest(await this.runtimeConfigs!.get(id),value.sourceInspection?.dependencyAnalysis?.dependencies);
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
      const resolved=runtime?.type==='runtime_launcher'?await resolveManagedMigrationEnvironment(this.environments,runtime.environmentId):null;
      if(!resolved)return null;
      return {jobId:experiment.jobId,candidateDigest:experiment.candidateDigest,environmentId:resolved.selected.environmentId,
        execution:experiment.execution,evidence:experiment.evidence,current:experiment.current,
        executionCheck:['HTTP_LOADED_DIGEST_CHECKED','SERVICE_BASELINE_AND_CANDIDATE_DIGEST_CHECKED'].includes(experiment.evidence)?'ARTIFACT_VERIFIED':experiment.execution==='completed'?'EXECUTION_COMPLETED':'NOT_COMPLETE',
        acceptance:experiment.acceptance,
        status:experiment.execution==='completed'?experiment.acceptance.status:experiment.execution==='failed'?'FAILED':['queued','preparing','running','judging'].includes(experiment.execution)?'RUNNING':'NOT_VALIDATED'};
    }))).filter(item=>item!==null);
    const currentOpenJiuwen=openJiuwenValidations.filter(item=>item.current).at(-1);
    const targetExecution=currentOpenJiuwen?.status??'NOT_RUN';
    const originalBaseline=experiments.filter(r=>r.pair==='SC'&&r.current).at(-1);
    const technicalReady=!!value.candidate&&!runtimeRequirements&&(value.inspection?.tools??[]).every(tool=>technicalValidations.some(result=>result.current&&result.toolId===tool.toolId&&result.status==='PASSED'));
    const evaluationCompleted=experiments.some(experiment=>experiment.current&&!['queued','preparing','running','judging','MISSING'].includes(experiment.execution));
    const workflow=migrationWorkflow(value,{migrationPlan,runtimeBuilderRequired:!!runtimeRequirements,technicalReady,evaluationCompleted});
    return {project:value,workflow,diagnosis,inspection:value.inspection??null,decisions:value.decisions??[],migrationPlan,runtimeRequirements,portableGenerationDiff:value.portableGenerationDiff??[],technicalValidations,openJiuwenValidations,professionalReview:value.reviews?.filter(r=>r.candidateDigest===value.candidate?.artifactSha256).at(-1)??null,verification:{originalBaseline:originalBaseline?.evidence==='SERVICE_BASELINE_AND_CANDIDATE_DIGEST_CHECKED'?'CAPTURED':originalBaseline?'NOT_COMPLETE':'NOT_RUN',targetExecution,
      candidateChanged:false,
      originalOwner:'原工程负责人',targetOwner:'Harness / Host 接入开发者',
      missingSource:diagnosis?.findings.filter(f=>f.layer==='UNKNOWN').map(f=>({path:f.path,line:f.line,reason:f.reason}))??[],
      targetGaps:[targetExecution==='PASSED'?'当前候选通过自动验收，但原环境对照与人类专业签署尚未完成':'当前候选尚未通过完整业务验收，请查看工具调用证据、必备规则和质量评分',
        '需冻结等价测试数据与可信身份范围；配置声明不等于授权已核验']},
      suites:await Promise.all((value.suiteIds??[]).map(suiteId=>this.preparations?.get(suiteId)??null)),
      optimizations:await Promise.all((value.optimizations??[]).map(async link=>({...link,item:await this.optimizers?.get(link.optimizationId)}))),
      experiments, attribution:'BC compares target execution stacks, including Harness; not a pure Runtime effect.'};
  }
}
