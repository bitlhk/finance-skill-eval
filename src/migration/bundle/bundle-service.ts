import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { writeJsonAtomic, readJson, listJsonFiles } from '../../service/file-store.js';
import { KeyedQueue } from '../../shared/keyed-queue.js';
import type { SkillStore } from '../../service/skill-store.js';
import { canonicalSha256 } from '../../shared/json-canonicalization.js';
import { simpleMigrationCases, simpleMigrationHoldoutCases } from '../domain/simple-migration-suite.js';
import type { BundleAgent, BundleRuntimeFactory, BundleJudge } from './bundle-ports.js';
import {
  analysisSchema,
  deliverySchema,
  bundleIdSchema,
  bundleError,
  createBundleSchema,
  operationSchema,
  configurationSchema,
  bundleSuiteSchema,
  snapshot,
  decodeBundleZip,
  bundleZip,
  bundleDiff,
  currentCandidate,
  verifiedRun,
  readText,
  type BundleTask,
  type BundleSnapshot,
  type BundleAttempt,
  type BundleRun,
  type BundleFiles,
} from './bundle-model.js';

/** One task owns one full workspace. Persisted candidates and run inputs are immutable. */
export class BundleMigrationService {
  private queue = new KeyedQueue();
  private active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closing = false;
  private static executing = 0;
  constructor(
    private root: string,
    private skills: SkillStore,
    private agent: BundleAgent,
    private runtime: BundleRuntimeFactory,
    private judge: BundleJudge,
  ) {}
  private taskFile(id: string) {
    bundleIdSchema.parse(id);
    return path.join(this.root, 'migration-bundles', 'tasks', id + '.json');
  }
  private snapshotFile(id: string, revision: string) {
    bundleIdSchema.parse(id);
    if (!/^(source|candidate-[a-f0-9-]+)$/.test(revision)) bundleError('版本标识无效', 400);
    return path.join(this.root, 'migration-bundles', 'snapshots', id, revision + '.json');
  }
  async initialize() {
    for (const task of await this.list()) {
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
      if (changed) await writeJsonAtomic(this.taskFile(task.id), task);
    }
  }
  async list() {
    const files = await listJsonFiles(path.join(this.root, 'migration-bundles', 'tasks'));
    return (await Promise.all(files.map((file) => readJson<BundleTask>(file)))).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }
  async get(id: string): Promise<BundleTask> {
    try {
      return await readJson<BundleTask>(this.taskFile(id));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') bundleError('迁移任务不存在', 404);
      throw e;
    }
  }
  async readSnapshot(id: string, candidateId: string | null) {
    await this.get(id);
    return readJson<BundleSnapshot>(this.snapshotFile(id, candidateId ?? 'source'));
  }
  private update(id: string, change: (task: BundleTask) => void | Promise<void>) {
    return this.queue.run(id, async () => {
      const task = await this.get(id);
      await change(task);
      await writeJsonAtomic(this.taskFile(id), task);
      return task;
    });
  }
  private idle(task: BundleTask) {
    if (task.attempts.some((a) => a.status === 'RUNNING')) bundleError('任务正在执行，请等待或取消当前操作');
  }
  async create(input: unknown) {
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
    return this.createFiles(parsed, files);
  }
  async upload(input: unknown, zip: Buffer) {
    const parsed = createBundleSchema.omit({ sourceAssetIds: true }).parse(input);
    return this.createFiles(parsed, decodeBundleZip(zip));
  }
  private async createFiles(input: { name: string; goal: string; target: string }, files: BundleFiles) {
    const id = 'bundle-' + randomUUID(),
      source = snapshot(files, 'source');
    const { files: _, ...sourceInfo } = source;
    const task: BundleTask = {
      schemaVersion: 'finance.skill-migration.bundle.v1',
      id,
      ...input,
      createdAt: new Date().toISOString(),
      source: sourceInfo,
      currentCandidateId: null,
      candidates: [],
      attempts: [],
      runs: [],
    };
    await writeJsonAtomic(this.snapshotFile(id, 'source'), source);
    await writeJsonAtomic(this.taskFile(id), task);
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
    const result = await this.runtime({
      snapshot: await this.readSnapshot(id, candidate.id),
      services: candidate.services,
      configuration: task.configuration,
      signal: AbortSignal.timeout(60000),
    });
    return {
      status: 'READY',
      scope: 'CAPABILITIES_AND_BINDINGS',
      message: '运行能力及配置检查通过；实际执行由联合验收核验',
      runtime: result.environmentSnapshot,
    };
  }
  async start(id: string, kind: BundleAttempt['kind'], input: unknown) {
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
      if (BundleMigrationService.executing >= 2) bundleError('整组任务执行资源繁忙，请稍后重试', 429);
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
        if (!task.currentCandidateId || !task.configuration || !task.suite)
          bundleError('请先生成候选、配置环境并保存验收用例');
        if (parsed.phase === 'holdout' && !task.suite.holdoutCases?.length)
          bundleError('尚未配置独立留出案例');
      }
      BundleMigrationService.executing++;
      reserved = true;
      task.attempts.push({
        id: 'attempt-' + randomUUID(),
        kind,
        key: parsed.key,
        requestDigest,
        baseCandidateId: parsed.baseCandidateId,
        ...(parsed.runId ? { runId: parsed.runId } : {}),
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
        message: kind === 'ACCEPT' ? '准备整组联合验收' : '准备完整工作区',
      });
    }).catch((error) => {
      if (reserved) BundleMigrationService.executing--;
      throw error;
    });
    if (duplicate) return task;
    const attempt = task.attempts[task.attempts.length - 1]!,
      controller = new AbortController();
    const done = this.execute(task, attempt, parsed.phase, controller.signal).finally(() => {
      this.active.delete(id);
      BundleMigrationService.executing--;
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
      if (attempt.kind === 'ACCEPT') await this.accept(task, attempt, phase, signal);
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
          await writeJsonAtomic(this.snapshotFile(task.id, candidate.id), revision);
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
    } catch (error) {
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
  private async accept(
    task: BundleTask,
    attempt: BundleAttempt,
    phase: 'development' | 'holdout',
    signal: AbortSignal,
  ) {
    const candidate = currentCandidate(task)!,
      configuration = task.configuration!,
      suite = task.suite!,
      bundle = await this.readSnapshot(task.id, candidate.id);
    const run: BundleRun = {
      id: 'bundle-run-' + randomUUID(),
      candidateId: candidate.id,
      candidateDigest: candidate.digest,
      configuration,
      configurationDigest: canonicalSha256(configuration),
      suite,
      suiteDigest: canonicalSha256(suite),
      phase,
      status: 'RUNNING',
      createdAt: new Date().toISOString(),
      cases: [],
    };
    await this.update(task.id, (t) => {
      t.runs.push(run);
    });
    const cases = phase === 'holdout' ? simpleMigrationHoldoutCases(suite) : simpleMigrationCases(suite);
    const receipts: unknown[] = [];
    for (const evalCase of cases) {
      signal.throwIfAborted();
      await this.progress(task.id, attempt.id, '联合验收：' + evalCase.caseId);
      // A new instance per case; the entire group is loaded on every execution.
      const execution = await this.runtime({
        snapshot: bundle,
        services: candidate.services,
        configuration,
        signal,
      });
      if (
        run.runtimeSnapshot &&
        canonicalSha256(run.runtimeSnapshot) !== canonicalSha256(execution.environmentSnapshot)
      )
        bundleError('运行环境在验收过程中发生变化，请重新验收');
      run.runtimeSnapshot = execution.environmentSnapshot;
      const variant = {
        mode: 'skill_version' as const,
        skillId: task.id,
        version: candidate.id,
        artifactSha256: bundle.digest,
      };
      try {
        await execution.runtime.prepare?.({ runId: run.id, signal });
        const evidence = await execution.runtime.execute({
          runId: run.id,
          side: 'right',
          model: execution.model,
          variant,
          evalCase,
          signal,
        });
        const valid =
          evidence.status === 'completed' &&
          evidence.streamCompleted &&
          evidence.runtimeIdentityVerified &&
          evidence.metadata.bundleDigest === bundle.digest &&
          bundle.members.every((m) =>
            evidence.loadedSkills.some(
              (loaded) => loaded.skillId === m.skillId && loaded.version === m.version,
            ),
          );
        const verdict = valid
          ? await this.judge({ evalCase, evidence, signal })
          : { passed: false, reason: '执行未完成，或整组装载证据不完整' };
        run.cases.push({ id: evalCase.caseId, ...verdict, evidence });
      } catch (error) {
        if (signal.aborted) throw error;
        run.cases.push({
          id: evalCase.caseId,
          passed: false,
          reason: error instanceof Error ? error.message : '执行失败',
        });
      } finally {
        try {
          await execution.runtime.cleanup?.();
        } finally {
          receipts.push(execution.runtime.finalizationEvidence?.() ?? { status: 'UNKNOWN' });
          run.finalization = receipts;
          await this.update(task.id, (t) => {
            const index = t.runs.findIndex((r) => r.id === run.id);
            t.runs[index] = structuredClone(run);
          });
        }
      }
    }
    signal.throwIfAborted();
    run.status = run.cases.length === cases.length && run.cases.every((c) => c.passed) ? 'PASSED' : 'FAILED';
    run.finishedAt = new Date().toISOString();
    await this.update(task.id, (t) => {
      t.runs[t.runs.findIndex((r) => r.id === run.id)] = run;
    });
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
  async export(id: string, verified = false) {
    const task = await this.get(id),
      candidate = currentCandidate(task);
    if (!candidate) bundleError('尚未生成候选');
    const run = verifiedRun(task);
    if (verified && !run) bundleError('当前候选及配置尚未通过所需联合验收');
    const bundle = await this.readSnapshot(id, candidate.id);
    if (verified && run) {
      const current = await this.runtime({
        snapshot: bundle,
        services: candidate.services,
        configuration: run.configuration,
        signal: AbortSignal.timeout(60000),
      });
      if (canonicalSha256(current.environmentSnapshot) !== canonicalSha256(run.runtimeSnapshot))
        bundleError('运行环境已变化，需要对当前环境重新验收');
    }
    const files = Object.fromEntries(
      Object.entries(bundle.files).map(([name, value]) => ['package/' + name, value]),
    );
    const add = (name: string, data: unknown) => {
      files[name] = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
    };
    add('migration/manifest.json', {
      schemaVersion: task.schemaVersion,
      candidate,
      configuration: task.configuration,
      verified: verified && Boolean(run),
    });
    add('migration/acceptance.json', run ?? { status: 'NOT_VERIFIED' });
    return bundleZip(files);
  }
}
