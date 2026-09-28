import { z } from 'zod';
import { resolveMigrationEnvironment, type MigrationEnvironmentRepository } from './migration-environment-repository.js';
import type { MigrationEvaluationJobReader } from './migration-evaluation-ports.js';
import { configurationDigest } from '../domain/migration-runtime-configuration.js';
import type { MigrationOptimizationPort } from './migration-optimization-port.js';
import type { MigrationSkillRepository } from './migration-skill-repository.js';
import type { MigrationProjectStore } from './migration-project-store.js';
import type { MigrationTechnicalValidationWorkflow } from './migration-technical-validation-service.js';
import { migrationConflict as conflict } from './migration-errors.js';
import type { MigrationRuntimeConfigurationRepository } from './migration-runtime-configuration-repository.js';

export class MigrationOptimizationService {
  constructor(
    private readonly projects:MigrationProjectStore,
    private readonly skills:MigrationSkillRepository,
    private readonly jobs:MigrationEvaluationJobReader,
    private readonly technicalValidation:MigrationTechnicalValidationWorkflow,
    private readonly optimizers?:MigrationOptimizationPort,
    private readonly environments?:MigrationEnvironmentRepository,
    private readonly runtimeConfigs?:MigrationRuntimeConfigurationRepository,
  ) {}

  async optimize(id:string,input:unknown) {
    return this.projects.runExclusive(id,async()=>{
      const parsed=z.strictObject({jobId:z.string().min(1)}).parse(input),value=await this.projects.get(id);
      if (!this.optimizers || !value.candidate) return conflict('优化器或候选不可用');
      if(value.generation)return conflict('生成候选需先完成原生迁移验证；当前 Host 适配验收尚未完成，暂不进入表达优化');
      const experiment=value.runs.find(run=>run.jobId===parsed.jobId);
      if (!experiment || experiment.candidateDigest!==value.candidate.artifactSha256) return conflict('请为当前候选选择一次运行记录');
      if(value.schemaVersion==='finance.skill-migration.v2'){
        const technical=await this.technicalValidation.currentState(value);
        if(!technical.ready)return conflict(`请先完成当前 Tool 技术验证：${technical.reasons.join('；')}`);
        const selectedRuntime=experiment.declaredPlan?.configuration.runtime;
        const environmentId=selectedRuntime?.type==='runtime_launcher'?selectedRuntime.environmentId:null;
        const environment=environmentId?(await resolveMigrationEnvironment(this.environments,environmentId))?.launcher:null;
        if(!environment||environment.runtimeType!=='openjiuwen')return conflict('请先完成当前候选的本地 OpenJiuwen 评估');
      }
      if(value.sourceInspection?.dependencyAnalysis?.dependencies.some(dependency=>dependency.owner==='RUNTIME'&&dependency.action==='INJECT')
        &&experiment.runtimeConfigurationDigest!==configurationDigest(await this.runtimeConfigs!.get(id),value.sourceInspection.dependencyAnalysis.dependencies)) {
        return conflict('运行配置已变化，请重新评估后再优化');
      }
      const job=this.jobs.get(parsed.jobId),variant=job?.report?.variants.right;
      if (variant?.mode!=='skill_version' || variant.artifactSha256!==value.candidate.artifactSha256) return conflict('缺少已完成的右侧候选运行证据');
      const item=await this.optimizers.create(parsed.jobId);
      (value.optimizations??=[]).push({optimizationId:item.optimizationId,sourceJobId:parsed.jobId,baseAssetId:value.candidate.assetId,candidateDigest:value.candidate.artifactSha256});
      await this.projects.save(value);
      return item;
    });
  }

  async adopt(id:string,input:unknown) {
    return this.projects.runExclusive(id,async()=>{
      const parsed=z.strictObject({optimizationId:z.string().min(1)}).parse(input),value=await this.projects.get(id);
      const link=value.optimizations?.find(optimization=>optimization.optimizationId===parsed.optimizationId);
      if (!link || !this.optimizers || value.candidate?.assetId!==link.baseAssetId) return conflict('这次优化与当前候选无关，或它的基线候选已变化');
      const item=await this.optimizers.get(parsed.optimizationId);
      if (!item.candidate || !['review','adopted'].includes(item.status)) return conflict('优化候选必须先跑完复测才能采用');
      await this.skills.readArchive(item.candidate.assetId);
      value.candidate=item.candidate;
      value.candidateNotes=`Optimization ${item.optimizationId}: ${item.summary}`;
      (value.candidateHistory??=[]).push({asset:item.candidate,notes:value.candidateNotes,recordedAt:new Date().toISOString(),kind:'optimization'});
      // Adoption is a local candidate choice, not migration or business acceptance.
      await this.projects.save(value);
      return value;
    });
  }
}
