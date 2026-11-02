import { assertMigrationExportSafe } from '../../domain/migration-export-safety.js';
import { canonicalSha256 } from '../../../shared/json-canonicalization.js';
import { currentCandidate, verifiedRun, bundleError, bundleZip, requireBuilderEnvironment, taskBuilderStatus } from '../domain/task-model.js';
import type { MigrationTaskRepository, BundleRuntimeFactory } from './task-ports.js';
import { reviewPlanEnvironment } from '../domain/task-runtime-review.js';
import {runtimeInputIssues} from '../domain/task-runtime-inputs.js';
export async function exportMigrationTask(repository: MigrationTaskRepository, runtime: BundleRuntimeFactory, id: string, verified = false, judgeDigest?: string) {
  const task = await repository.get(id),
    candidate = currentCandidate(task);
  if (!candidate) bundleError('尚未生成候选');
  const run = verifiedRun({...task, currentJudgeDigest: judgeDigest});
  if (verified && !run) bundleError('当前候选及配置尚未通过所需联合验收');
  const bundle = await repository.readSnapshot(id, candidate.id);
  if (verified && run) {
    const issues=runtimeInputIssues(task,run.configuration,true);if(issues.length)bundleError(issues.join('；'));
    const current = await runtime({
      snapshot: bundle,
      services: candidate.services,
      configuration: run.configuration,
      signal: AbortSignal.timeout(60000),
    });
    requireBuilderEnvironment(task, current.environmentSnapshot);
    if(reviewPlanEnvironment(task,current.environmentSnapshot).status==='FAILED') bundleError('运行环境不满足当前方案要求');
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
  if(task.analysis?.standardization){
    add('migration/standardization.json',{standard:task.analysis.standardization,tools:candidate.tools,
      conformance:candidate.conformance,independentToolChecks:candidate.contractEvidence,
      requirementCoverage:run?.requirementCoverage??[],
      verificationScope:{environment:run?.runtimeSnapshot??null,crossFramework:'NOT_VERIFIED',
        note:'仅声明记录中的实际环境及用例结果；单环境通过不等于所有框架均已实测。'}});
  }
  const plan=task.planRevisions?.find(item=>item.id===candidate.planRevisionId);
  add('migration/plan.json',plan ?? {analysis:task.analysis,status:'LEGACY_RECORD'});
  if(task.runtimeReview) add('migration/runtime-review.json',{...task.runtimeReview,current:
    task.runtimeReview.candidateId===candidate.id && task.runtimeReview.configurationDigest===canonicalSha256(task.configuration)
    && task.runtimeReview.planDigest===(task.analysis?canonicalSha256(task.analysis):undefined)
    && task.runtimeReview.runtimeSelectionRevision===task.runtimeSelectionRevision});
  if (task.selectedRuntimeBuildRequestId) {
    add('migration/runtime-build-requirements.json', task.runtimeBuildRequests?.find(r => r.requirements.requestId === task.selectedRuntimeBuildRequestId)?.requirements);
    if (task.runtimeDelivery?.requestId === task.selectedRuntimeBuildRequestId) add('migration/runtime-build-result.json', task.runtimeDelivery.result);
  }
  return bundleZip(files);
}
