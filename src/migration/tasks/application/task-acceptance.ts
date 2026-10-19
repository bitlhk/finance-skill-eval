import { randomUUID } from 'node:crypto';
import { canonicalSha256 } from '../../../shared/json-canonicalization.js';
import { operationalError } from '../../../shared/operational-error.js';
import { simpleMigrationCases, simpleMigrationHoldoutCases } from '../../domain/simple-migration-suite.js';
import { currentCandidate, bundleError, type BundleTask, type BundleAttempt, type BundleRun } from '../domain/task-model.js';
import type { MigrationTaskRepository, BundleRuntimeFactory, BundleJudge, MigrationLogger } from './task-ports.js';
type AcceptanceContext = Pick<MigrationTaskRepository, 'update' | 'readSnapshot'> & {
  runtime: BundleRuntimeFactory; judge: BundleJudge; logger?: MigrationLogger;
  progress(id: string, attemptId: string, message: string): Promise<void>;
};
export async function acceptMigrationTask(
  context: AcceptanceContext,
  task: BundleTask,
  attempt: BundleAttempt,
  phase: 'development' | 'holdout',
  signal: AbortSignal,
) {
  const candidate = currentCandidate(task)!,
    configuration = task.configuration!,
    suite = task.suite!,
    bundle = await context.readSnapshot(task.id, candidate.id);
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
  await context.update(task.id, (t) => {
    t.runs.push(run);
    t.attempts.find(a => a.id === attempt.id)!.runId = run.id;
  });
  const cases = phase === 'holdout' ? simpleMigrationHoldoutCases(suite) : simpleMigrationCases(suite);
  const receipts: unknown[] = [];
  for (const evalCase of cases) {
    signal.throwIfAborted();
    context.logger?.info({
      event: 'bundle_case_started', taskId: task.id, attemptId: attempt.id, requestId: attempt.requestId, runId: run.id,
      caseId: evalCase.caseId, phase, candidateId: candidate.id
    });
    await context.progress(task.id, attempt.id, '联合验收：' + evalCase.caseId);
    // A new instance per case; the entire group is loaded on every execution.
    const execution = await context.runtime({
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
        ? await context.judge({ evalCase, evidence, signal, correlation: { taskId: task.id, attemptId: attempt.id, runId: run.id, requestId: attempt.requestId } })
        : { passed: false, reason: '执行未完成，或整组装载证据不完整' };
      run.cases.push({ id: evalCase.caseId, ...verdict, evidence });
      context.logger?.info({
        event: 'bundle_case_finished', taskId: task.id, attemptId: attempt.id, requestId: attempt.requestId, runId: run.id,
        caseId: evalCase.caseId, passed: verdict.passed, elapsedMs: evidence.elapsedMs
      });
    } catch (error) {
      context.logger?.warn({
        event: 'bundle_case_failed', taskId: task.id, attemptId: attempt.id, requestId: attempt.requestId, runId: run.id,
        caseId: evalCase.caseId, err: operationalError(error)
      });
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
        await context.update(task.id, (t) => {
          const index = t.runs.findIndex((r) => r.id === run.id);
          t.runs[index] = structuredClone(run);
        });
      }
    }
  }
  signal.throwIfAborted();
  run.status = run.cases.length === cases.length && run.cases.every((c) => c.passed) ? 'PASSED' : 'FAILED';
  run.finishedAt = new Date().toISOString();
  await context.update(task.id, (t) => {
    t.runs[t.runs.findIndex((r) => r.id === run.id)] = run;
  });
}
