import { originalServiceFingerprint } from '../../original-service-runtime.js';
import type { MigrationEvaluationJobReader } from './migration-evaluation-ports.js';
import { resolveMigrationEnvironment, type MigrationEnvironmentRepository } from './migration-environment-repository.js';
import type { MigrationOptimizationPort } from './migration-optimization-port.js';
import type { MigrationPreparationRepository } from './migration-preparation-repository.js';
import type { MigrationProjectStore } from './migration-project-store.js';
import type { MigrationRuntimeConfigurationRepository } from './migration-runtime-configuration-repository.js';
import type { MigrationDiagnosisPort } from './migration-diagnosis-port.js';
import { assessMigrationAcceptance } from '../domain/migration-acceptance.js';
import { projectMigrationPlan } from '../domain/migration-reuse-design.js';
import { executionConfigurationDigest as configurationDigest } from '../../execution-configuration/execution-configuration.js';
import { migrationWorkflow } from '../domain/migration-workflow.js';
import { solutionRevision } from '../domain/migration-solution-revision.js';
import {currentRuntimeReuse,reusedCapabilitiesDigest} from '../domain/migration-runtime-reuse.js';
import type {ReuseAcceptanceSummary} from '../domain/migration-reuse-acceptance.js';
import {migrationDeliveryStatus} from '../domain/migration-delivery-status.js';
import {unresolvedMigrationRuntimeRequirements} from './migration-runtime-requirements.js';

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
    private readonly readReuseAcceptance?:(id:string)=>Promise<ReuseAcceptanceSummary>,
  ) {}

  async report(id:string) {
    const value=await this.projects.get(id);
    const reuse=currentRuntimeReuse(value),reusedEnvironment=reuse?await resolveMigrationEnvironment(this.environments,reuse.environmentId):null;
    const runtimeReuse=reuse&&reusedEnvironment?.launcher.environmentId===reuse.launcherEnvironmentId&&reusedEnvironment.launcher.updatedAt===reuse.environmentUpdatedAt?reuse:null;
    const runtimeRequirements=await unresolvedMigrationRuntimeRequirements(value,this.environments);
    const diagnosis=this.diagnostics?.peek?await this.diagnostics.peek(value.source):this.diagnostics?await this.diagnostics.diagnose(value.source):null;
    const currentAsset=value.candidate??value.source;
    const runtimeDigest=configurationDigest(await this.runtimeConfigs!.get(id),value.sourceInspection?.dependencyAnalysis?.dependencies);
    const technicalValidations=(value.technicalValidations??[]).map(result=>({...result,current:result.assetDigest===currentAsset.artifactSha256&&(!result.runtimeConfigurationDigest||result.runtimeConfigurationDigest===runtimeDigest)}));
    const migrationPlan=projectMigrationPlan(value);
    const experiments=await Promise.all(value.runs.map(async r=>{
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
      const finalVerification=value.improvementTasks?.some(task=>task.finalConsumed&&task.finalJobId===r.jobId)??false;
      const definitions=[...(r.suiteSnapshot?.cases??[]).filter(item=>!selected.length||selected.includes(item.caseId)),
        ...(finalVerification?r.suiteSnapshot?.holdoutCases??[]:[])];
      const acceptance=assessMigrationAcceptance(job?.report??null,definitions,complete);
      let solutionCurrent=true;
      if(r.solutionRevisions&&r.declaredPlan){
        const configuration=r.declaredPlan.configuration;
        for(const side of ['left','right'] as const){
          const recorded=r.solutionRevisions[side];
          if(!recorded)continue;
          const binding=configuration.runtimeBindings?.[side];
          const resolved=binding?await resolveMigrationEnvironment(this.environments,binding.environmentId):null;
          const asset=side==='right'?currentAsset:[value.source,currentAsset,...(value.candidateHistory??[]).map(item=>item.asset)]
            .find(item=>item.assetId===recorded.skill.assetId)??value.source;
          const current=resolved?solutionRevision({asset,side,configuration,configurationDigest:runtimeDigest,environment:resolved,verifiedCapabilitiesDigest:reusedCapabilitiesDigest(value,resolved)}):null;
          if(!current||current.revisionId!==recorded.revisionId||(recorded.bindingFingerprint&&current.bindingFingerprint!==recorded.bindingFingerprint)){
            solutionCurrent=false;
            break;
          }
        }
      }
return {...r,current:r.candidateDigest===currentAsset.artifactSha256&&(!value.sourceInspection?.dependencyAnalysis?.dependencies.some(d=>d.owner==='RUNTIME'&&d.action==='INJECT')||r.runtimeConfigurationDigest===runtimeDigest)&&solutionCurrent&&(!r.reuseProposalId||r.reuseProposalId===migrationPlan?.reuseProposal?.proposalId),comparisonKind:r.pair==='CC'?'SAME_SKILL_RUNTIME_ASSESSMENT':r.pair==='AC'?'WHOLE_SOLUTION':r.pair==='SC'?'ORIGINAL_SERVICE':r.pair==='BC'?'TARGET_ASSESSMENT':'CONTROLLED_SKILL',execution:job?.status??'MISSING',createdAt:job?.createdAt,updatedAt:job?.updatedAt,report:job?.report??null,error:job?.error??null,evidence:complete?(r.pair==='SC'?'SERVICE_BASELINE_AND_CANDIDATE_DIGEST_CHECKED':'HTTP_LOADED_DIGEST_CHECKED'):'NOT_COMPLETE',acceptance,
        taskSuccess:'NOT_INDEPENDENTLY_VERIFIED',professionalAcceptance:'NOT_REVIEWED',migrationAcceptance:'NOT_VALIDATED'};
    }));
    const optimizations=await Promise.all((value.optimizations??[]).map(async link=>({...link,item:await this.optimizers?.get(link.optimizationId)})));
    const improvementPlans=(value.improvementPlans??[]).map(plan=>{
      const experiment=experiments.find(item=>item.jobId===plan.sourceJobId);
      const optimization=optimizations.find(item=>item.planId===plan.planId);
      const rebuild=value.runtimeRebuilds?.find(item=>item.requirements.rebuild?.hypothesis.id===plan.planId);
      const task=value.improvementTasks?.find(item=>item.iterations.some(iteration=>iteration.planId===plan.planId));
      const rebuildStatus=task?.finalVerified&&task.status==='ADOPTED'?'VERIFIED_ADOPTED'
        :task?.finalVerified&&task.status==='REVIEW'?'VERIFIED_REVIEW'
          :value.runtimeDelivery?.requirementsDigest===rebuild?.requirements.requirementsDigest?'DELIVERED':'REQUESTED';
        const toolAttempt=value.toolOptimizationAttempts?.filter(item=>item.planId===plan.planId).at(-1);
      return {...plan,current:plan.candidateDigest===currentAsset.artifactSha256&&experiment?.current===true,
        action:optimization?{kind:'SKILL_OPTIMIZATION' as const,status:optimization.item?.status??'MISSING',referenceId:optimization.optimizationId}
          :rebuild?{kind:'BUILDER_REBUILD' as const,status:rebuildStatus,referenceId:rebuild.requirements.requestId}
            :toolAttempt?{kind:'TOOL_OPTIMIZATION' as const,status:toolAttempt.status,referenceId:toolAttempt.attemptId}
          :{kind:'NOT_STARTED' as const,status:'PLANNED',referenceId:null}};
    });
    const openJiuwenValidations=(await Promise.all(experiments.map(async experiment=>{
      const runtime=experiment.declaredPlan?.configuration.runtime;
      const resolved=runtime?.type==='runtime_launcher'?await resolveMigrationEnvironment(this.environments,runtime.environmentId):null;
      if(!resolved)return null;
      return {jobId:experiment.jobId,pair:experiment.pair,candidateDigest:experiment.candidateDigest,environmentId:resolved.selected.environmentId,
        execution:experiment.execution,evidence:experiment.evidence,current:experiment.current,
        executionCheck:['HTTP_LOADED_DIGEST_CHECKED','SERVICE_BASELINE_AND_CANDIDATE_DIGEST_CHECKED'].includes(experiment.evidence)?'ARTIFACT_VERIFIED':experiment.execution==='completed'?'EXECUTION_COMPLETED':'NOT_COMPLETE',
        acceptance:experiment.acceptance,
        status:experiment.execution==='completed'?experiment.acceptance.status:experiment.execution==='failed'?'FAILED':['queued','preparing','running','judging'].includes(experiment.execution)?'RUNNING':'NOT_VALIDATED'};
    }))).filter(item=>item!==null);
    // Integrated reuse cases are not a replacement for the selected business assessment.
    const currentTarget=experiments.filter(item=>item.current&&['BC','SC'].includes(item.pair)&&!item.reuseAcceptanceTaskId).at(-1);
    const targetExecution=currentTarget?.execution==='completed'?currentTarget.acceptance.status
      :currentTarget?.execution==='failed'?'FAILED':currentTarget&&['queued','preparing','running','judging'].includes(currentTarget.execution)?'RUNNING':'NOT_RUN';
    const reuseConformance=value.inspection?.reuseConformance;
    const originalBaseline=experiments.filter(r=>r.pair==='SC'&&r.current).at(-1);
    const technicalReady=!!value.candidate&&!runtimeRequirements&&(value.inspection?.tools??[]).every(tool=>technicalValidations.some(result=>result.current&&result.toolId===tool.toolId&&result.status==='PASSED'));
    const evaluationCompleted=experiments.some(experiment=>experiment.current&&['BC','SC'].includes(experiment.pair)&&!experiment.reuseAcceptanceTaskId&&!['queued','preparing','running','judging','MISSING'].includes(experiment.execution));
    const workflow=migrationWorkflow(value,{migrationPlan,runtimeRequirementsPending:!!runtimeRequirements,technicalReady,evaluationCompleted});
    const reuseAcceptance=this.readReuseAcceptance?await this.readReuseAcceptance(id):null;
    const proposal=migrationPlan?.reuseProposal;
    const reuseDesign=reuseConformance?.review&&proposal?.approvedAt&&reuseConformance.candidateDigest===value.candidate?.artifactSha256&&reuseConformance.proposalId===proposal.proposalId
      &&reuseConformance.review.changes.length===proposal.design.changes.length
      &&new Set(reuseConformance.review.changes.map(change=>change.changeId)).size===proposal.design.changes.length
      &&reuseConformance.review.changes.every(change=>change.status==='CONFORMING'&&change.evidence.length>0&&proposal.design.changes.some(expected=>expected.id===change.changeId))
      &&!reuseConformance.review.unexpectedDependencies.length&&!reuseConformance.review.semanticIssues.length?'REVIEWED':'NOT_REVIEWED';
    const delivery=migrationDeliveryStatus({targetExecution,reuseDesign,reuseAcceptance:reuseAcceptance?.status??'NOT_RUN',technicalReady});
    return {project:value,workflow,diagnosis,inspection:value.inspection??null,decisions:value.decisions??[],migrationPlan,runtimeRequirements,runtimeReuse,portableGenerationDiff:value.portableGenerationDiff??[],technicalValidations,openJiuwenValidations,professionalReview:value.reviews?.filter(r=>r.candidateDigest===value.candidate?.artifactSha256).at(-1)??null,verification:{originalBaseline:originalBaseline?.evidence==='SERVICE_BASELINE_AND_CANDIDATE_DIGEST_CHECKED'?'CAPTURED':originalBaseline?'NOT_COMPLETE':'NOT_RUN',targetExecution,
      reuseDesign,delivery,
      reuseAcceptance:reuseAcceptance?.status??'NOT_RUN',
      candidateChanged:false,
      originalOwner:'原工程负责人',targetOwner:'Harness / Host 接入开发者',
      missingSource:diagnosis?.findings.filter(f=>f.layer==='UNKNOWN').map(f=>({path:f.path,line:f.line,reason:f.reason}))??[],
      targetGaps:[...delivery.gaps,delivery.status==='VERIFIED'?'已通过当前版本的自动检查；不代表生产授权或人类专业签署':'可下载用于检查，但尚未完成全部自动检查',
        '需冻结等价测试数据与可信身份范围；配置声明不等于授权已核验']},
      suites:await Promise.all((value.suiteIds??[]).map(suiteId=>this.preparations?.get(suiteId)??null)),
        optimizations,improvementPlans,toolOptimizationAttempts:value.toolOptimizationAttempts??[],reuseAcceptance,
      experiments, attribution:'BC compares target execution stacks, including Harness; not a pure Runtime effect.'};
  }
}
