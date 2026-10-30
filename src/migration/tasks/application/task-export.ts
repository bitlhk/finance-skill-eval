import { assertMigrationExportSafe } from '../../domain/migration-export-safety.js';
import { canonicalSha256 } from '../../../shared/json-canonicalization.js';
import { currentCandidate, verifiedRun, bundleError, bundleZip, requireBuilderEnvironment, taskBuilderStatus } from '../domain/task-model.js';
import type { MigrationTaskRepository, BundleRuntimeFactory } from './task-ports.js';
export async function exportMigrationTask(repository: MigrationTaskRepository, runtime: BundleRuntimeFactory, id: string, verified = false, judgeDigest?: string) {
  const task = await repository.get(id),
    candidate = currentCandidate(task);
  if (!candidate) bundleError('尚未生成候选');
  const run = verifiedRun({...task, currentJudgeDigest: judgeDigest});
  if (verified && !run) bundleError('当前候选及配置尚未通过所需联合验收');
  const bundle = await repository.readSnapshot(id, candidate.id);
  if (verified && run) {
    const current = await runtime({
      snapshot: bundle,
      services: candidate.services,
      configuration: run.configuration,
      signal: AbortSignal.timeout(60000),
    });
    requireBuilderEnvironment(task, current.environmentSnapshot);
    if (canonicalSha256(current.environmentSnapshot) !== canonicalSha256(run.runtimeSnapshot))
      bundleError('运行环境已变化，需要对当前环境重新验收');
  }
  const files = Object.fromEntries(
    Object.entries(bundle.files).map(([name, value]) => ['package/' + name, value]),
  );
  assertMigrationExportSafe(Object.fromEntries(Object.entries(files).map(([name, content]) => [name, Buffer.from(content, 'base64')])));
  const add = (name: string, data: unknown) => {
    files[name] = Buffer.from(JSON.stringify(data, null, 2)).toString('base64');
  };
  add('migration/manifest.json', {
    schemaVersion: task.schemaVersion,
    candidate,
    configuration: task.configuration,
    runtimeSelectionRevision: task.runtimeSelectionRevision,
    verified: verified && Boolean(run),
    builderStatus: taskBuilderStatus(task),
    builderBinding: taskBuilderStatus(task) === 'BOUND' ? task.runtimeDelivery : undefined,
  });
  add('migration/acceptance.json', run ?? { status: 'NOT_VERIFIED' });
  if (task.selectedRuntimeBuildRequestId) {
    add('migration/runtime-build-requirements.json', task.runtimeBuildRequests?.find(r => r.requirements.requestId === task.selectedRuntimeBuildRequestId)?.requirements);
    if (task.runtimeDelivery?.requestId === task.selectedRuntimeBuildRequestId) add('migration/runtime-build-result.json', task.runtimeDelivery.result);
  }
  return bundleZip(files);
}
