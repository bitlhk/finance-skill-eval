import { z } from 'zod';
import { fingerprint } from '../../contracts.js';
import { originalServiceFingerprint } from '../../original-service-runtime.js';
import type { MigrationEvalPackCatalog } from './migration-eval-pack-catalog.js';
import { runConfigurationSchema } from '../../shared/contracts/run-configuration.js';
import type { MigrationEvaluationRunner } from './migration-evaluation-ports.js';
import { executionConfigurationDigest as configurationDigest } from '../../execution-configuration/execution-configuration.js';
import type { MigrationEvaluationModels } from './migration-evaluation-models.js';
import type { MigrationPreparationRepository } from './migration-preparation-repository.js';
import type { MigrationPreparationPackFactory } from './migration-preparation-pack-factory.js';
import type { MigrationProjectStore } from './migration-project-store.js';
import { migrationConflict as conflict } from './migration-errors.js';
import type { MigrationRuntimeConfigurationRepository } from './migration-runtime-configuration-repository.js';
import { resolveMigrationEnvironment,verifyRuntimeReuse, type MigrationEnvironmentRepository } from './migration-environment-repository.js';
import { solutionRevision } from '../domain/migration-solution-revision.js';
import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';
import type {EvalPack} from '../../contracts.js';
import type {RuntimeBuildRequirements} from '../../shared/contracts/runtime-builder.js';
import {unresolvedMigrationRuntimeRequirements} from './migration-runtime-requirements.js';
import {currentRuntimeReuse,reusedCapabilitiesDigest} from '../domain/migration-runtime-reuse.js';
import {currentReuseProposal} from '../domain/migration-reuse-design.js';

/** Internal-only experiment context; HTTP callers cannot bypass candidate or holdout guards. */
export type MigrationExperimentContext={candidate:SkillAssetRecord;expectedPackFingerprint:string;frozenSuite?:EvalPack;finalVerification?:boolean;runtimeRequirements?:RuntimeBuildRequirements};

export function frozenSuiteFingerprint(pack:EvalPack){
  return fingerprint({cases:pack.cases,holdoutCases:pack.holdoutCases??[],judgeProfile:pack.judgeProfile,metadata:pack.metadata});
}

const planSchema = z.strictObject({
  pair:z.enum(['AB','BC','AC','SC','CC']), configuration:runConfigurationSchema,
  dataSnapshot:z.string().min(1).max(300), permissionBasis:z.string().min(1).max(1000),
  sourceProjectRef:z.string().min(1).max(1000), dependencyLockRef:z.string().min(1).max(1000),
});

export class MigrationEvaluationService {
  constructor(
    private readonly projects:MigrationProjectStore,
    private readonly runs:MigrationEvaluationRunner,
    private readonly catalog:MigrationEvalPackCatalog,
    private readonly preparations?:MigrationPreparationRepository,
    private readonly preparationPacks?:MigrationPreparationPackFactory,
    private readonly models?:MigrationEvaluationModels,
    private readonly runtimeConfigs?:MigrationRuntimeConfigurationRepository,
    private readonly environments?:MigrationEnvironmentRepository,
  ) {}

  async validate(id:string,input:unknown,experiment?:MigrationExperimentContext) {
    return this.projects.runExclusive(id,async()=>{
      const p=planSchema.parse(input), value=await this.projects.get(id), c=experiment?.candidate??value.candidate;
      if (!c || !p.configuration.runtimeBindings) return conflict('缺少候选或左右两侧的绑定');
      const reuseProposal=currentReuseProposal(value);
      if(value.reuseProposal&&(!reuseProposal?.approvedAt||value.candidateReuseProposalId!==reuseProposal.proposalId))
        return conflict('候选尚未落实当前确认的迁移方案，请重新确认并生成后评测');
      if(p.configuration.runtime.type!=='runtime_launcher')return conflict('Skill 迁移评测必须使用 Runtime Launcher');
      const launcherEnvironmentId=p.configuration.runtime.environmentId;
      const runtimeComparison=p.pair==='CC';
      if(runtimeComparison!==(p.configuration.evaluationMode==='candidate_runtime_comparison'))return conflict('CC 必须使用同候选跨 Runtime 评估模式');
      await verifyRuntimeReuse(value,this.environments,launcherEnvironmentId);
      const runtimeIds=runtimeComparison?[p.configuration.runtimeBindings.left.environmentId,p.configuration.runtimeBindings.right.environmentId]:[launcherEnvironmentId];
      for(const runtimeId of runtimeIds){
        const selected=await resolveMigrationEnvironment(this.environments,runtimeId);
        if(await unresolvedMigrationRuntimeRequirements(value,this.environments,selected??undefined,experiment?.runtimeRequirements))
          return conflict('Runtime 能力尚未确认：请先核对并复用已有 Runtime，或接入 Builder 交付后再评测');
      }
      const solutionComparison=p.pair==='AC'&&p.configuration.evaluationMode==='solution_comparison';
      if((p.pair==='AC')!==(p.configuration.evaluationMode==='solution_comparison'))return conflict('整套方案对比必须使用 AC 对比计划');
      if((runtimeComparison?p.configuration.runtimeBindings.left.environmentId:p.configuration.runtimeBindings.right.environmentId)!==launcherEnvironmentId
        ||(!solutionComparison&&!runtimeComparison&&p.configuration.runtimeBindings.left.environmentId!==launcherEnvironmentId))return conflict('左右执行绑定必须属于所选 Runtime Launcher');
      if(solutionComparison&&p.configuration.runtimeBindings.left.environmentId===p.configuration.runtimeBindings.right.environmentId)return conflict('整套方案对比需要分别选择旧版和新版 Runtime Launcher');
      let pack=p.configuration.packId ? this.catalog.get(p.configuration.packId):null;
      if (p.configuration.preparationId) {
        if (!value.suiteIds?.includes(p.configuration.preparationId)) return conflict('请选择属于本次迁移的冻结测试集');
        const preparation=await this.preparations?.get(p.configuration.preparationId);
        if (preparation) pack=this.preparationPacks!.build({preparation,analyzerModel:this.models!.analyzer(),
          executionModel:p.configuration.executionModel!,judgeModel:this.models!.judge()});
      }
      if (!pack || (p.configuration.includeHoldout&&!experiment?.finalVerification)) return conflict('请选择一个冻结的开发题集；留出题留给独立复评');
      if(experiment&&(experiment.frozenSuite?frozenSuiteFingerprint(pack)!==frozenSuiteFingerprint(experiment.frozenSuite)
        :pack.packFingerprint!==experiment.expectedPackFingerprint))return conflict('冻结测试集已变化，不能继续本次改进试验');
      const serviceComparison=p.pair==='SC'&&p.configuration.evaluationMode==='service_comparison';
      if((p.pair==='SC')!==(p.configuration.evaluationMode==='service_comparison'))return conflict('原服务对比必须使用 SC 对比计划');
      if(pack.metadata.assessmentMode==='natural_language'&&(!(runtimeComparison||serviceComparison||solutionComparison||(p.pair==='BC'&&p.configuration.evaluationMode==='candidate_assessment'))||p.configuration.judgeMode!=='model'))return conflict('自然语言测试集仅用于目标评估或对比评估');
      if(serviceComparison&&pack.metadata.assessmentMode!=='natural_language')return conflict('原服务对比请选择包含任务输入和验收要求的测试集');
      if(pack.metadata.comparisonOnly==='true'&&!serviceComparison)return conflict('这份测试集以原服务为基线，请选择原服务对比；目标评估需另外提供独立验收要求');
      const knownAssets=[value.source,c,...(value.candidateHistory??[]).map(item=>item.asset)];
      const comparisonBaseline=knownAssets.find(item=>item.assetId===p.configuration.runtimeBindings!.left.skillAssetId);
      if(solutionComparison&&!comparisonBaseline)return conflict('整套方案对比的旧版 Skill 不属于当前迁移工程');
      const expected=p.pair==='AB' ? [value.source,c] : p.pair==='BC'||runtimeComparison ? [c,c] : p.pair==='AC' ? [comparisonBaseline!,c] : [value.source,c];
      for (const [index,side] of (['left','right'] as const).entries()) {
        const binding=p.configuration.runtimeBindings[side], variant=p.configuration[side==='left'?'leftVariant':'rightVariant'];
        const asset=expected[index]!;
        if (binding.skillAssetId!==asset.assetId || variant?.mode!=='skill_version' || variant.artifactSha256!==asset.artifactSha256
            || variant.skillId!==asset.skillId || variant.version!==asset.version) return conflict('左右绑定与冻结的源/候选不一致');
      }
      if(p.pair==='BC'&&p.configuration.evaluationMode!=='candidate_assessment')return conflict('BC 是对迁移候选的质量评估，不是左右胜负比较');
      if (p.pair==='AB' && p.configuration.runtimeBindings.left.environmentId!==p.configuration.runtimeBindings.right.environmentId) return conflict('AB 对照必须保持原 Runtime 环境一致');
      const runtimeConfigurationDigest=configurationDigest(await this.runtimeConfigs!.get(id),value.sourceInspection?.dependencyAnalysis?.dependencies);
      const revisions=await (async()=>{
        if(!this.environments)return undefined;
        const right=await resolveMigrationEnvironment(this.environments,p.configuration.runtimeBindings!.right.environmentId);
        const left=serviceComparison?null:await resolveMigrationEnvironment(this.environments,p.configuration.runtimeBindings!.left.environmentId);
        if(!right||(!serviceComparison&&!left))return conflict('所选 Runtime Launcher 不可用');
        return {
          left:left?solutionRevision({asset:expected[0]!,side:'left',configuration:p.configuration,configurationDigest:runtimeConfigurationDigest,environment:left,verifiedCapabilitiesDigest:reusedCapabilitiesDigest(value,left)}):null,
          right:solutionRevision({asset:expected[1]!,side:'right',configuration:p.configuration,configurationDigest:runtimeConfigurationDigest,environment:right,verifiedCapabilitiesDigest:reusedCapabilitiesDigest(value,right)}),
        };
      })();
      const comparisonFingerprint=fingerprint({runtimeConfigurationDigest,pack:pack.packFingerprint, model:p.configuration.executionModel,
        reuseProposalId:reuseProposal?.approvedAt?reuseProposal.proposalId:null,
        sideModels:{left:p.configuration.leftExecutionModel??p.configuration.executionModel,right:p.configuration.rightExecutionModel??p.configuration.executionModel},
        solutionRevisions:revisions,
        cases:p.configuration.selectedCaseIds, data:p.dataSnapshot, permissions:p.permissionBasis,
        sourceProject:p.sourceProjectRef, lock:p.dependencyLockRef,evaluationMode:p.configuration.evaluationMode,
        ...(runtimeComparison?{pair:p.pair,candidate:c,bindings:p.configuration.runtimeBindings,
          models:{left:p.configuration.leftExecutionModel,right:p.configuration.rightExecutionModel},
          variants:{left:p.configuration.leftVariant,right:p.configuration.rightVariant}}:{}),
        ...(p.configuration.originalService?{originalService:originalServiceFingerprint(p.configuration.originalService)}:{})});
      const job=await this.runs.create(p.configuration);
      value.runs.push({jobId:job.jobId,pair:p.pair,candidateDigest:c.artifactSha256,comparisonFingerprint,packFingerprint:pack.packFingerprint,declaredPlan:p,suiteSnapshot:pack,runtimeConfigurationDigest,
        ...(reuseProposal?.approvedAt?{reuseProposalId:reuseProposal.proposalId}:{}),...(revisions?{solutionRevisions:revisions}:{})});
      await this.projects.save(value);
      return {job,comparisonFingerprint,acceptance:'NOT_VALIDATED',note:'Runs are experiments; declared environment/material references are not native-runtime or authorization attestation.'};
    });
  }

}
