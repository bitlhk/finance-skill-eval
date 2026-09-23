import { z } from 'zod';
import { fingerprint } from '../../contracts.js';
import { originalServiceFingerprint } from '../../original-service-runtime.js';
import type { MigrationEvalPackCatalog } from './migration-eval-pack-catalog.js';
import { runConfigurationSchema } from '../../shared/contracts/run-configuration.js';
import type { MigrationEvaluationRunner } from './migration-evaluation-ports.js';
import { configurationDigest } from '../domain/migration-runtime-configuration.js';
import type { MigrationEvaluationModels } from './migration-evaluation-models.js';
import type { MigrationPreparationRepository } from './migration-preparation-repository.js';
import type { MigrationPreparationPackFactory } from './migration-preparation-pack-factory.js';
import type { MigrationProjectStore } from './migration-project-store.js';
import { migrationConflict as conflict } from './migration-errors.js';
import type { MigrationRuntimeConfigurationRepository } from './migration-runtime-configuration-repository.js';

const planSchema = z.strictObject({
  pair:z.enum(['AB','BC','AC','SC']), configuration:runConfigurationSchema,
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
  ) {}

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
        if (preparation) pack=this.preparationPacks!.build({preparation,analyzerModel:this.models!.analyzer(),
          executionModel:p.configuration.executionModel!,judgeModel:this.models!.judge()});
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
      const runtimeConfigurationDigest=configurationDigest(await this.runtimeConfigs!.get(id),value.sourceInspection?.dependencyAnalysis?.dependencies);
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

}
