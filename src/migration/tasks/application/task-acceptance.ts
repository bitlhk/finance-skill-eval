import { randomUUID } from 'node:crypto';
import type {RuntimeExecutionEvidence} from '../../../contracts.js';
import { canonicalSha256 } from '../../../shared/json-canonicalization.js';
import { operationalError } from '../../../shared/operational-error.js';
import { simpleMigrationCases, simpleMigrationHoldoutCases } from '../../domain/simple-migration-suite.js';
import { currentCandidate, bundleError, requireBuilderEnvironment, type BundleTask, type BundleAttempt, type BundleRun } from '../domain/task-model.js';
import type { MigrationTaskRepository, BundleRuntimeFactory, BundleJudge, MigrationLogger } from './task-ports.js';
import { reviewPlanEnvironment } from '../domain/task-runtime-review.js';
import {executeEvaluationCase} from '../../../evaluation/application/execute-case.js';
import {checkExecutionEvidence} from '../../../evaluation/domain/execution-checks.js';
import {evaluateMethods} from '../../../evaluation/application/evaluation-method.js';
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
    judgeDigest: context.judge.identity?.(),
    ...(task.runtimeSelectionRevision ? { runtimeSelectionRevision: task.runtimeSelectionRevision } : {}),
    ...(task.selectedRuntimeBuildRequestId ? { builderBindingId: task.runtimeDelivery!.id } : {}),
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
  const authoredCases=phase==='holdout'?(suite.holdoutCases??[]):suite.cases;
  const requirements=task.analysis?.standardization?.requirements??[];
  if(authoredCases.some(c=>c.requirementIds?.some(id=>!requirements.some(r=>r.id===id))))bundleError('测试案例引用了当前方案之外的要求，请重新关联');
  const receipts: unknown[] = [];
  let incomplete = false;
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
    try{
    requireBuilderEnvironment(task, execution.environmentSnapshot);
    if(reviewPlanEnvironment(task,execution.environmentSnapshot).status==='FAILED') bundleError('运行环境不满足当前方案的能力要求');
    if (
      run.runtimeSnapshot &&
      canonicalSha256(run.runtimeSnapshot) !== canonicalSha256(execution.environmentSnapshot)
    )
      bundleError('运行环境在验收过程中发生变化，请重新验收');
    run.runtimeSnapshot = execution.environmentSnapshot;
    }catch(error){
      try{await execution.runtime.cleanup?.();}finally{
        receipts.push(execution.runtime.finalizationEvidence?.()??{status:'UNKNOWN'});
        run.finalization=receipts;
        await context.update(task.id,t=>{t.runs[t.runs.findIndex(r=>r.id===run.id)]=structuredClone(run);});
      }
      throw error;
    }
    const variant = {
      mode: 'skill_version' as const,
      skillId: task.id,
      version: candidate.id,
      artifactSha256: bundle.digest,
    };
    let evidence:RuntimeExecutionEvidence|undefined;
    let judgeComposition:import('../../../shared/contracts/agent-composition.js').AgentCompositionReceipt|undefined;
    try {
      await execution.runtime.prepare?.({ runId: run.id, signal });
      const observed = await executeEvaluationCase({runtime:execution.runtime,failureMode:'throw',request:{
        runId: run.id,
        side: 'right',
        model: execution.model,
        variant,
        evalCase,
        signal,
      }});
      evidence = observed;
      const methodResults=await evaluateMethods({evalCase,evidence,signal},[{
        id:'bundle-execution',version:'1',kind:'RULE',
        evaluate:({evidence})=>checkExecutionEvidence(evidence,{contentDigest:bundle.digest,members:bundle.members}),
      }]);
      const executionChecks=methodResults[0]!.checks;
      const verifiedExecution=executionChecks.filter(c=>c.id!=='execution.completed').every(c=>c.status==='PASS');
      const valid=methodResults[0]!.status==='PASS';
      const ids=authoredCases.find(c=>c.id===evalCase.caseId)?.requirementIds??[];
      const verdict = valid
        ? await context.judge({ evalCase, evidence, requirements:requirements.filter(r=>ids.includes(r.id)),tools:candidate.tools,signal,
            onComposition:receipt=>{judgeComposition=receipt;},
            correlation: { taskId: task.id, attemptId: attempt.id, runId: run.id, requestId: attempt.requestId } })
        : { passed: false, reason: '执行未完成，或整组装载证据不完整' };
      if(!valid)incomplete=true;
      if (run.judgeDigest !== context.judge.identity?.()) bundleError('Judge 配置在验收期间发生变化，请重新验收');
      run.cases.push({ id: evalCase.caseId, ...verdict, evidence, executionChecks, ...(judgeComposition?{judgeComposition}:{}), ...(!valid ? {failureStage:verifiedExecution ? 'EXECUTION' as const : 'RUNTIME' as const} : {}) });
      context.logger?.info({
        event: 'bundle_case_finished', taskId: task.id, attemptId: attempt.id, requestId: attempt.requestId, runId: run.id,
        caseId: evalCase.caseId, passed: verdict.passed, elapsedMs: evidence.elapsedMs
      });
    } catch (error) {
      context.logger?.warn({
        event: 'bundle_case_failed', taskId: task.id, attemptId: attempt.id, requestId: attempt.requestId, runId: run.id,
        caseId: evalCase.caseId, err: operationalError(error)
      });
      incomplete = true;
      run.cases.push({
        id: evalCase.caseId,
        passed: false,
        reason: error instanceof Error ? error.message : '执行失败',
        ...(evidence ? {evidence} : {}),
        ...(judgeComposition?{judgeComposition}:{}),
        failureStage: evidence ? 'JUDGE' : 'RUNTIME',
      });
      if (signal.aborted) throw error;
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
  if(requirements.length){
    run.requirementCoverage=requirements.map(requirement=>{
      const checked=run.cases.filter(c=>c.requirementResults?.some(r=>r.id===requirement.id));
      const failed=checked.some(c=>c.requirementResults?.some(r=>r.id===requirement.id&&!r.passed));
      return {id:requirement.id,status:failed?'FAILED' as const:checked.length?'PASSED' as const:'UNVERIFIED' as const,caseIds:checked.map(c=>c.id)};
    });
    if(run.requirementCoverage.some(r=>r.status==='UNVERIFIED'))incomplete=true;
  }
  run.status = incomplete ? 'INCOMPLETE' : run.cases.length === cases.length && run.cases.every((c) => c.passed) ? 'PASSED' : 'FAILED';
  run.finishedAt = new Date().toISOString();
  await context.update(task.id, (t) => {
    t.runs[t.runs.findIndex((r) => r.id === run.id)] = run;
  });
}
