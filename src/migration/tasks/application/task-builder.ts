import { runtimeSkillSetFromFiles, skillSetFileStats } from '../../../shared/contracts/runtime-skills.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canonicalSha256 } from '../../../shared/json-canonicalization.js';
import { capabilityRequirementSchema, withRequirementsDigest, runtimeBuildResultSchema } from '../../../shared/contracts/runtime-builder.js';
import { RUNTIME_CAPABILITIES_SCHEMA_VERSION, RUNTIME_INSTANCE_SCHEMA_VERSION, RUNTIME_EXECUTION_SCHEMA_VERSION, RUNTIME_OBSERVATION_SCHEMA_VERSION } from '../../../shared/contracts/runtime-protocol-versions.js';
import { currentCandidate, candidateUsesCurrentPlan, bundleError, configurationSchema, taskBuilderStatus, type BundleTask, type TaskBuildRequest, type TaskRuntimeDelivery } from '../domain/task-model.js';
import { assertMigrationExportSafe } from '../../domain/migration-export-safety.js';
import type { MigrationTaskRepository, TaskBuilderPort, MigrationLogger } from './task-ports.js';
import {assertOptimizationInputs,waitingOptimization} from './task-optimization-state.js';

export const taskBuildInputSchema = configurationSchema.omit({ environmentId: true, modelId: true }).extend({
  baseCandidateId: z.string().min(1),
  runtimeType: z.enum(['openjiuwen', 'agentscope', 'ea', 'generic_http']),
  modelId: z.string().min(1).optional(),
  requiredCapabilities: z.array(capabilityRequirementSchema).max(100).default([]),
  platform: z.strictObject({os:z.enum(['linux','windows','darwin']),arch:z.string().min(1),isolation:z.string().min(1)}),
});
const intakeSchema = z.strictObject({ result: runtimeBuildResultSchema, trustReference: z.string().regex(/^[a-z0-9-]+$/), name: z.string().trim().min(1).max(80).optional() });
const idle = (task: BundleTask) => { if (task.attempts.some(a => a.status === 'RUNNING')) bundleError('任务正在执行，请等待或取消当前操作'); };

/** Keeps network admission and task binding under the same task write lock. */
export class TaskBuilderService {
  constructor(private repository: MigrationTaskRepository, private port: TaskBuilderPort, private logger?: MigrationLogger) {}
  async request(id: string, input: unknown, httpRequestId?: string) {
    const parsed = taskBuildInputSchema.parse(input);
    const updated = await this.repository.update(id, async task => {
      idle(task);
      const optimization=waitingOptimization(task),waiting=optimization?.optimization?.waiting;
      if(optimization)assertOptimizationInputs(task,optimization);
      if(waiting&&waiting.kind!=='BUILDER')bundleError('本轮等待的不是 Builder 调整');
      const candidate = waiting?task.candidates.find(c=>c.id===waiting.candidate.id):currentCandidate(task);
      if (!candidate || candidate.id !== parsed.baseCandidateId) bundleError('候选已变化，请刷新后导出需求');
      if (!candidateUsesCurrentPlan(task)) bundleError('当前结果对应旧方案，请确认新方案并重新生成');
      const { baseCandidateId: _, runtimeType, requiredCapabilities: extraCapabilities, platform, ...settings } = parsed;
      const requiredCapabilities = [...(task.analysis?.plan?.requiredCapabilities ?? [])];
      const diagnosis=optimization?.optimization?.rounds.at(-1)?.diagnosis;
      for (const capability of [...extraCapabilities,...(diagnosis?.status==='PROPOSED'?diagnosis.hypothesis.requiredCapabilities??[]:[])]) {
        const existing=requiredCapabilities.find(item=>item.id===capability.id);
        if(existing && canonicalSha256(existing)!==canonicalSha256(capability)) bundleError('补充能力合同与迁移方案冲突');
        if(!existing) requiredCapabilities.push(capability);
      }
      const snapshot = await this.repository.readSnapshot(id, candidate.id);
      if (settings.entryInstructionsFile && !(settings.entryInstructionsFile in snapshot.files)) bundleError('入口指令文件不存在', 400);
      const stats = skillSetFileStats(runtimeSkillSetFromFiles(snapshot));
      const baseline=task.selectedRuntimeBuildRequestId?task.runtimeDelivery?.launcher:undefined;
      const requirements = withRequirementsDigest({
        schemaVersion: 'finance.runtime-build-requirements.v3', requestId: 'build-request-' + randomUUID(),
        target: { runtimeType, protocols: { capabilities: RUNTIME_CAPABILITIES_SCHEMA_VERSION, instance: RUNTIME_INSTANCE_SCHEMA_VERSION, execution: RUNTIME_EXECUTION_SCHEMA_VERSION, observation: RUNTIME_OBSERVATION_SCHEMA_VERSION } },
        requiredCapabilities,
        ...(baseline&&optimization&&diagnosis?.status==='PROPOSED'?{rebuild:{
          baseline:{deploymentId:baseline.deploymentId,artifactSha256:baseline.artifactSha256,capabilitiesDigest:baseline.capabilitiesDigest},
          hypothesis:{id:optimization.id,issue:diagnosis.hypothesis.issue,expectedBehavior:diagnosis.hypothesis.expectedBehavior},
          evidence:diagnosis.hypothesis.evidenceCaseIds.map(evidenceRef=>({evidenceRef,summary:diagnosis.hypothesis.validation.slice(0,1000)})),
        }}:{}),
        executionRequirements: { platform,
          features: ['processEvidence', 'streaming', ...(candidate.services.length ? ['packagedMcp' as const] : []),
            ...((task.suite?.cases??[]).some(c=>c.evaluationPlan?.checks.some(check=>[...check.evidenceRefs,check.rule?.reference??''].some(ref=>ref.startsWith('/telemetry'))))?['otlpEvidence' as const]:[]),
            ...((task.suite?.cases??[]).some(c=>c.evaluationPlan?.checks.some(check=>[...check.evidenceRefs,check.rule?.reference??''].some(ref=>ref.startsWith('/artifacts'))))?['artifactEvidence' as const]:[]),
            ...([...(task.suite?.cases??[]),...(task.suite?.holdoutCases??[])].some(c=>c.stateFixture)?['caseStateLifecycle' as const]:[])],
          limits: {maxSkills: candidate.members.length, maxFiles: stats.count, maxArchiveBytes: stats.bytes, maxTimeoutMs: settings.timeoutMs},
        },
      });
      const request: TaskBuildRequest = { requirements, candidateId: candidate.id, candidateDigest: candidate.digest,
        ...(optimization?{optimizationAttemptId:optimization.id}:{}),
        settings, baseConfigurationDigest: canonicalSha256(task.configuration ?? null), createdAt: new Date().toISOString() };
      (task.runtimeBuildRequests ??= []).push(request);
      task.selectedRuntimeBuildRequestId = requirements.requestId;
      task.runtimeSelectionRevision = 'selection-' + randomUUID();
      if(waiting)waiting.requestId=requirements.requestId;
    });
    const request = updated.runtimeBuildRequests!.at(-1)!;
    this.logger?.info({ event: 'migration_builder_requirements_created', taskId: id, requestId: httpRequestId,
      buildRequestId: request.requirements.requestId, requirementsDigest: request.requirements.requirementsDigest, candidateId: request.candidateId });
    return updated;
  }
  async requirements(id: string, requestId?: string) {
    const task = await this.repository.get(id);
    const request = task.runtimeBuildRequests?.find(r => r.requirements.requestId === (requestId ?? task.selectedRuntimeBuildRequestId));
    if (!request) bundleError('请先生成 Builder 需求', 404);
    return request.requirements;
  }
  async useExisting(id: string) {
    return this.repository.update(id, task => { idle(task);if(waitingOptimization(task)?.optimization?.waiting?.kind==='BUILDER')bundleError('本轮正在等待 Builder 改造，不能用原环境跳过；可以停止优化'); if (task.selectedRuntimeBuildRequestId) task.runtimeSelectionRevision = 'selection-' + randomUUID(); delete task.selectedRuntimeBuildRequestId; });
  }
  async accept(id: string, input: unknown, httpRequestId?: string) {
    const intake = intakeSchema.safeParse(input);
    if (!intake.success) bundleError('Builder 交付不符合当前标准协议', 400);
    const parsed = intake.data;
    assertMigrationExportSafe({ 'runtime-build-result.json': Buffer.from(JSON.stringify(parsed.result)) });
    const started = Date.now();
    const correlation = { taskId: id, requestId: httpRequestId, buildRequestId: parsed.result.requestId, buildId: parsed.result.buildId, resultDigest: parsed.result.resultDigest };
    this.logger?.info({ event: 'migration_builder_delivery_started', ...correlation });
    try {
      const updated = await this.repository.update(id, async task => {
        idle(task);
        const request = task.runtimeBuildRequests?.find(r => r.requirements.requestId === parsed.result.requestId);
        if (!request || task.selectedRuntimeBuildRequestId !== parsed.result.requestId) bundleError('Builder 需求已被替换或不属于此任务');
        const optimization=request.optimizationAttemptId?waitingOptimization(task):undefined;
        if(request.optimizationAttemptId&&(!optimization||optimization.id!==request.optimizationAttemptId||optimization.optimization?.waiting?.requestId!==request.requirements.requestId))bundleError('该 Builder 需求对应的优化轮次已结束或被替换');
        if(optimization)assertOptimizationInputs(task,optimization);
        const candidate = optimization?task.candidates.find(c=>c.id===request.candidateId):currentCandidate(task);
        if (!candidate) bundleError('请先生成候选');
        const replay = task.runtimeDelivery?.requestId === parsed.result.requestId;
        if (replay && (task.runtimeDelivery!.result.resultDigest !== parsed.result.resultDigest || taskBuilderStatus(task) !== 'BOUND')) bundleError('该需求已绑定其他交付或配置已变化，请生成新需求');
        const accepted = await this.port.accept({ request, configuration: task.configuration, result: parsed.result, trustReference: parsed.trustReference, name: parsed.name,
          snapshot: await this.repository.readSnapshot(id, candidate.id), services: candidate.services });
        const binding: TaskRuntimeDelivery = {
          id: replay ? task.runtimeDelivery!.id : 'binding-' + randomUUID(), requestId: request.requirements.requestId,
          requirementsDigest: request.requirements.requirementsDigest,
          environmentSnapshot: accepted.environmentSnapshot, launcher: accepted.launcher, result: parsed.result,
        };
        // Same delivery is idempotent only while its admitted environment snapshot is unchanged.
        if (replay && canonicalSha256(binding.environmentSnapshot) !== canonicalSha256(task.runtimeDelivery!.environmentSnapshot)) bundleError('交付环境已变化，请生成新需求并重新接收');
        task.configuration = accepted.configuration;
        task.runtimeDelivery = binding;
        if (!replay) (task.runtimeDeliveries ??= []).push(binding);
      });
      const binding = updated.runtimeDelivery!;
      this.logger?.info({ event: 'migration_builder_delivery_bound', ...correlation, bindingId: binding.id,
        environmentId: binding.launcher.environmentId, deploymentId: binding.launcher.deploymentId,
        conformanceRunId: binding.launcher.evalConformance.runId, elapsedMs: Date.now() - started });
      return updated;
    } catch (error) {
      this.logger?.warn({ event: 'migration_builder_delivery_failed', ...correlation, elapsedMs: Date.now() - started });
      throw error;
    }
  }
}
