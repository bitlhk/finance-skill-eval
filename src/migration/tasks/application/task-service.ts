import { exportMigrationTask } from './task-export.js';
import { acceptMigrationTask } from './task-acceptance.js';
import { randomUUID } from 'node:crypto';
import { operationalError } from '../../../shared/operational-error.js';
import { canonicalSha256 } from '../../../shared/json-canonicalization.js';
import { simpleMigrationCases } from '../../domain/simple-migration-suite.js';
import type { BundleAgent, BundleRuntimeFactory, BundleJudge, MigrationTaskRepository, MigrationSourceAssets, MigrationLogger, TaskBuilderPort } from './task-ports.js';
import { TaskBuilderService } from './task-builder.js';
import {
  analysisSchema,
  deliverySchema,
  bundleError,
  createBundleSchema,
  operationSchema,
  configurationSchema,
  bundleSuiteSchema,
  snapshot,
  decodeBundleZip,
  bundleDiff,
  currentCandidate,
  readText,
  taskBuilderStatus, requireTaskBuilderBinding, requireBuilderEnvironment,
  type BundleTask,
  type BundleAttempt,
  type BundleFiles,
} from '../domain/task-model.js';

/** One task owns one full workspace. Persisted candidates and run inputs are immutable. */
export class MigrationTaskService {
  private active = new Map<string, { controller: AbortController; done: Promise<void>; }>();
  private closing = false;
  private static executing = 0;
  constructor(
    private repository: MigrationTaskRepository,
    private skills: MigrationSourceAssets,
    private agent: BundleAgent,
    private runtime: BundleRuntimeFactory,
    private judge: BundleJudge,
    private logger?: MigrationLogger,
    builder?: TaskBuilderPort,
  ) { this.builder = builder ? new TaskBuilderService(repository, builder, logger) : undefined; }
  readonly builder?: TaskBuilderService;
  async initialize() {
    for (const task of await this.repository.list()) {
      let changed = false;
      for (const attempt of task.attempts)
        if (attempt.status === 'RUNNING') {
          attempt.status = 'INTERRUPTED';
          attempt.message = '服务已重启，本次操作中断；可重新发起';
          attempt.finishedAt = new Date().toISOString();
          changed = true;
        }
      for (const run of task.runs)
        if (run.status === 'RUNNING') {
          run.status = 'INCOMPLETE';
          run.finishedAt = new Date().toISOString();
          changed = true;
        }
      if (changed) {
        await this.repository.save(task);
        this.logger?.warn({ event: 'bundle_recovered_after_restart', taskId: task.id });
      }
    }
  }
  async list() { return (await this.repository.list()).map(t => ({ ...t, ...(t.selectedRuntimeBuildRequestId ? { builderStatus: taskBuilderStatus(t) } : {}) })); }
  async get(id: string) { const task = await this.repository.get(id); return { ...task, ...(task.selectedRuntimeBuildRequestId ? { builderStatus: taskBuilderStatus(task) } : {}) }; }
  readSnapshot(id: string, candidateId: string | null) { return this.repository.readSnapshot(id, candidateId); }
  private async update(id: string, change: (task: BundleTask) => void | Promise<void>) { const task = await this.repository.update(id, change); return { ...task, ...(task.selectedRuntimeBuildRequestId ? { builderStatus: taskBuilderStatus(task) } : {}) }; }
  private idle(task: BundleTask) {
    if (task.attempts.some((a) => a.status === 'RUNNING')) bundleError('任务正在执行，请等待或取消当前操作');
  }
  create(input: unknown, requestId?: string) { return this.createFromAssets(input, requestId); }
  private async createFromAssets(input: unknown, requestId?: string, origin?: BundleTask['origin']) {
    const parsed = createBundleSchema.parse(input);
    if (new Set(parsed.sourceAssetIds).size !== parsed.sourceAssetIds.length)
      bundleError('不能重复选择同一资产', 400);
    const files: BundleFiles = {};
    for (const [index, id] of parsed.sourceAssetIds.entries()) {
      const asset = await this.skills.get(id);
      if (!asset) bundleError('源 Skill 不存在', 404);
      const archive = await this.skills.readArchive(id);
      for (const [name, bytes] of Object.entries(archive))
        files['members/member-' + (index + 1) + '/' + name] = Buffer.from(bytes).toString('base64');
    }
    return this.createFiles(parsed, files, requestId, origin);
  }
  async importLegacy(input: unknown, origin: NonNullable<BundleTask['origin']>, requestId?: string) {
    return this.createFromAssets(input, requestId, origin);
  }
  async upload(input: unknown, zip: Buffer, requestId?: string) {
    const parsed = createBundleSchema.omit({ sourceAssetIds: true }).parse(input);
    return this.createFiles(parsed, decodeBundleZip(zip), requestId);
  }
  private async createFiles(input: { name: string; goal: string; target: string; }, files: BundleFiles, requestId?: string, origin?: BundleTask['origin']) {
    const id = 'bundle-' + randomUUID(),
      source = snapshot(files, 'source');
    const { files: _, ...sourceInfo } = source;
    const task: BundleTask = {
      schemaVersion: 'finance.skill-migration.bundle.v1',
      id,
      name: input.name, goal: input.goal, target: input.target,
      ...(origin ? { origin } : {}),
      requestId,
      createdAt: new Date().toISOString(),
      source: sourceInfo,
      currentCandidateId: null,
      candidates: [],
      attempts: [],
      runs: [],
    };
    await this.repository.saveSnapshot(id, 'source', source);
    await this.repository.save(task);
    this.logger?.info({ event: 'migration_task_created', taskId: task.id, requestId, memberCount: source.members.length });
    return task;
  }
  async configure(id: string, input: unknown) {
    const configuration = configurationSchema.parse(input);
    return this.update(id, (task) => {
      this.idle(task);
      task.configuration = configuration;
    });
  }
  async saveSuite(id: string, input: unknown) {
    const suite = bundleSuiteSchema.parse(input);
    return this.update(id, (task) => {
      this.idle(task);
      task.suite = suite;
    });
  }
  async checkRuntime(id: string) {
    const task = await this.get(id),
      candidate = currentCandidate(task);
    if (!candidate || !task.configuration) bundleError('请先生成候选并配置运行环境');
    requireTaskBuilderBinding(task);
    const result = await this.runtime({
      snapshot: await this.readSnapshot(id, candidate.id),
      services: candidate.services,
      configuration: task.configuration,
      signal: AbortSignal.timeout(60000),
    });
    requireBuilderEnvironment(task, result.environmentSnapshot);
    return {
      status: 'READY',
      scope: 'CAPABILITIES_AND_BINDINGS',
      message: '运行能力及配置检查通过；实际执行由联合验收核验',
      runtime: result.environmentSnapshot,
    };
  }
  async start(id: string, kind: BundleAttempt['kind'], input: unknown, requestId?: string) {
    const parsed = operationSchema.parse(input);
    const requestDigest = canonicalSha256({ kind, input: parsed });
    let duplicate = false,
      reserved = false;
    const task = await this.update(id, (task) => {
      const existing = task.attempts.find((a) => a.key === parsed.key);
      if (existing) {
        if (existing.requestDigest !== requestDigest) bundleError('请求标识已用于其他操作');
        duplicate = true;
        return;
      }
      if (this.closing) bundleError('服务正在关闭', 503);
      this.idle(task);
      if (MigrationTaskService.executing >= 2) bundleError('整组任务执行资源繁忙，请稍后重试', 429);
      if (parsed.baseCandidateId !== task.currentCandidateId) bundleError('候选已变化，请刷新后重试');
      if (kind === 'GENERATE' && (!task.analysis || task.analysis.missing.length))
        bundleError('请先完成整体分析并解决缺失信息');
      if (kind === 'REPAIR') {
        const run = task.runs.find((r) => r.id === parsed.runId);
        if (
          !run ||
          run.candidateId !== task.currentCandidateId ||
          !['FAILED', 'INCOMPLETE'].includes(run.status)
        )
          bundleError('请选择当前候选的失败验收记录');
        if (run.phase === 'holdout')
          bundleError('独立留出验收记录不提供给修复 Agent，请使用开发回归案例重现问题');
      }
      if (kind === 'ACCEPT') {
        requireTaskBuilderBinding(task);
        if (!task.currentCandidateId || !task.configuration || !task.suite)
          bundleError('请先生成候选、配置环境并保存验收用例');
        if (parsed.phase === 'holdout' && !task.suite.holdoutCases?.length)
          bundleError('尚未配置独立留出案例');
      }
      MigrationTaskService.executing++;
      reserved = true;
      task.attempts.push({
        id: 'attempt-' + randomUUID(),
        kind,
        requestId,
        ...(kind !== 'ACCEPT' ? { agentRunId: 'agent-' + randomUUID() } : {}),
        key: parsed.key,
        requestDigest,
        baseCandidateId: parsed.baseCandidateId,
        ...(parsed.runId ? { runId: parsed.runId } : {}),
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
        message: kind === 'ACCEPT' ? '准备整组联合验收' : '准备完整工作区',
      });
    }).catch((error) => {
      if (reserved) MigrationTaskService.executing--;
      throw error;
    });
    if (duplicate) return task;
    const attempt = task.attempts[task.attempts.length - 1]!,
      controller = new AbortController();
    this.logger?.info({
      event: 'bundle_operation_started', taskId: id, attemptId: attempt.id, requestId: attempt.requestId, agentRunId: attempt.agentRunId,
      kind, candidateId: attempt.baseCandidateId
    });
    const done = this.execute(task, attempt, parsed.phase, controller.signal).finally(() => {
      this.active.delete(id);
      MigrationTaskService.executing--;
    });
    this.active.set(id, { controller, done });
    return task;
  }
  private async progress(id: string, attemptId: string, message: string) {
    await this.update(id, (task) => {
      const attempt = task.attempts.find((a) => a.id === attemptId)!;
      attempt.message = message;
    });
  }
  private async execute(
    task: BundleTask,
    attempt: BundleAttempt,
    phase: 'development' | 'holdout',
    signal: AbortSignal,
  ) {
    try {
      if (attempt.kind === 'ACCEPT') await acceptMigrationTask({ update: this.update.bind(this), readSnapshot: this.readSnapshot.bind(this), progress: this.progress.bind(this), runtime: this.runtime, judge: this.judge, logger: this.logger }, task, attempt, phase, signal);
      else {
        const source = await this.readSnapshot(task.id, null),
          base = await this.readSnapshot(task.id, attempt.baseCandidateId);
        const prior = task.runs.find((run) => run.id === attempt.runId);
        // Only development observations reach the code agent, never any holdout suite.
        const feedback = prior
          ? {
            cases: prior.cases,
            inputs: simpleMigrationCases(prior.suite).map((c) => ({
              id: c.caseId,
              input: c.prompt,
              workspaceFiles: c.workspaceFiles,
              turns: c.turns,
            })),
            configuration: {
              environmentId: prior.configuration.environmentId,
              modelId: prior.configuration.modelId,
            },
          }
          : undefined;
        await this.progress(
          task.id,
          attempt.id,
          attempt.kind === 'ANALYZE'
            ? 'Agent 正在分析整组 Skill 与共享源码'
            : 'Agent 正在完整工作区改造，可跨 Skill 修改',
        );
        const result = await this.agent({
          correlation: { taskId: task.id, attemptId: attempt.id, requestId: attempt.requestId, agentRunId: attempt.agentRunId! },
          mode: attempt.kind,
          source,
          base,
          goal: task.goal,
          target: task.target,
          analysis: task.analysis,
          feedback,
          signal,
        });
        signal.throwIfAborted();
        if (result.status !== 'PRODUCED') bundleError(result.reason ?? 'Agent 需要补充信息');
        if (attempt.kind === 'ANALYZE') {
          const analysis = analysisSchema.parse(result.analysis);
          await this.update(task.id, (t) => {
            t.analysis = analysis;
          });
        } else {
          const delivery = deliverySchema.parse(result.delivery);
          if (!result.files) bundleError('Agent 没有交付完整候选文件');
          const revision = snapshot(result.files, 'r' + (task.candidates.length + 1), base);
          for (const service of delivery.services)
            for (const file of service.filePaths)
              if (!(file in revision.files)) bundleError('服务交付文件缺失：' + file);
          const toolNames = delivery.services.flatMap((s) => s.toolNames);
          if (new Set(toolNames).size !== toolNames.length) bundleError('共享服务工具名称冲突');
          const candidate = {
            id: 'candidate-' + randomUUID(),
            parentId: attempt.baseCandidateId,
            createdAt: new Date().toISOString(),
            digest: revision.digest,
            members: revision.members,
            summary: delivery.summary,
            services: delivery.services,
            diff: bundleDiff(base.files, revision.files),
            checks: ['MEMBER_ENTRIES', 'FRONTMATTER', 'PATHS', 'TOOL_NAMES'],
          };
          await this.progress(task.id, attempt.id, '文件及成员清单检查通过，正在冻结整组候选');
          signal.throwIfAborted();
          await this.repository.saveSnapshot(task.id, candidate.id, revision);
          await this.update(task.id, (t) => {
            signal.throwIfAborted();
            t.candidates.push(candidate);
            t.currentCandidateId = candidate.id;
          });
        }
      }
      await this.update(task.id, (t) => {
        const a = t.attempts.find((a) => a.id === attempt.id)!;
        a.status = 'COMPLETED';
        a.finishedAt = new Date().toISOString();
        a.message = attempt.kind === 'ACCEPT' ? '联合验收已结束，请查看验收结论' : '本阶段已完成';
      });
      this.logger?.info({
        event: 'bundle_operation_finished', taskId: task.id, attemptId: attempt.id, requestId: attempt.requestId, agentRunId: attempt.agentRunId,
        kind: attempt.kind, status: 'COMPLETED', elapsedMs: Date.now() - Date.parse(attempt.startedAt)
      });
    } catch (error) {
      this.logger?.warn({
        event: 'bundle_operation_finished', taskId: task.id, attemptId: attempt.id, requestId: attempt.requestId, agentRunId: attempt.agentRunId,
        kind: attempt.kind, status: signal.aborted ? 'CANCELLED' : 'FAILED',
        elapsedMs: Date.now() - Date.parse(attempt.startedAt), err: operationalError(error)
      });
      await this.update(task.id, (t) => {
        const a = t.attempts.find((a) => a.id === attempt.id)!;
        a.status = signal.aborted ? 'CANCELLED' : 'FAILED';
        a.finishedAt = new Date().toISOString();
        a.error = error instanceof Error ? error.message : '操作失败';
        a.message = signal.aborted ? '操作已取消' : '操作未完成';
        for (const run of t.runs)
          if (run.status === 'RUNNING') {
            run.status = signal.aborted ? 'CANCELLED' : 'INCOMPLETE';
            run.finishedAt = new Date().toISOString();
          }
      });
    }
  }
  async cancel(id: string) {
    await this.get(id);
    const active = this.active.get(id);
    if (active) {
      active.controller.abort(new Error('用户取消'));
      await active.done;
    }
    return this.get(id);
  }
  async close() {
    this.closing = true;
    const active = [...this.active.values()];
    for (const task of active) task.controller.abort(new Error('服务正在关闭'));
    await Promise.allSettled(active.map((t) => t.done));
  }
  async files(id: string, candidateId: string | null, name: string) {
    const bundle = await this.readSnapshot(id, candidateId);
    return { path: name, content: readText(bundle.files, name) };
  }
  export(id: string, verified = false) { return exportMigrationTask(this.repository, this.runtime, id, verified); }
}
