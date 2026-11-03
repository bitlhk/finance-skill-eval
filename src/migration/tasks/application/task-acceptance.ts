import { randomUUID } from 'node:crypto';
import type {RuntimeExecutionEvidence} from '../../../contracts.js';
import { canonicalSha256 } from '../../../shared/json-canonicalization.js';
import { operationalError } from '../../../shared/operational-error.js';
import { simpleMigrationCases, simpleMigrationHoldoutCases,simpleMigrationSuiteSchema } from '../../domain/simple-migration-suite.js';
import { currentCandidate, bundleError, requireBuilderEnvironment, type BundleTask, type BundleAttempt, type BundleRun } from '../domain/task-model.js';
import type { MigrationTaskRepository, BundleRuntimeFactory, BundleJudge, MigrationLogger } from './task-ports.js';
import { reviewPlanEnvironment } from '../domain/task-runtime-review.js';
import {executeEvaluationCase} from '../../../evaluation/application/execute-case.js';
import {checkExecutionEvidence} from '../../../evaluation/domain/execution-checks.js';
import {evaluateTaskCase} from './evaluate-task-case.js';

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
  purpose: 'baseline' | 'candidate' = 'candidate',
) {
  const total=simpleMigrationSuiteSchema.parse(task.suite).executionRepetitions??1,groupId='execution-group-'+randomUUID();
  for(let index=1;index<=total;index++){
    signal.throwIfAborted();
    const run=await acceptOnce(context,task,attempt,phase,signal,purpose,total>1?{groupId,index,total}:undefined);
    // Do not repeat uncertain business effects or a broken evaluation environment.
    const expectedCases=phase==='holdout'?task.suite!.holdoutCases!.length:task.suite!.cases.length;
    if(run.status==='INCOMPLETE'&&(run.cases.length!==expectedCases||run.cases.some(c=>c.failureStage)))break;
  }
}
async function acceptOnce(context:AcceptanceContext,task:BundleTask,attempt:BundleAttempt,phase:'development'|'holdout',
  signal:AbortSignal,purpose:'baseline'|'candidate',repetition?:BundleRun['repetition']){
  const preparation = purpose === 'baseline' ? task.preparations?.at(-1) : undefined;
  if (purpose === 'baseline' && (!preparation || !task.baselineConfiguration || !task.suite)) bundleError('基线输入尚未准备完整');
  const candidate = preparation ? {id:preparation.id,digest:preparation.digest,services:[],tools:undefined} : currentCandidate(task)!;
  const configuration = purpose === 'baseline' ? task.baselineConfiguration! : task.configuration!,
    suite = task.suite!,
    bundle = await context.readSnapshot(task.id, candidate.id);
  if (bundle.digest !== candidate.digest) bundleError('冻结文件与评测版本摘要不一致');
  const run: BundleRun = {
    ...(repetition?{repetition}:{}),
    assessmentRequirements:purpose==='candidate'?task.analysis?.standardization?.requirements??[]:[],
    ...(candidate.tools?{assessmentTools:candidate.tools}:{}),
    purpose,
    judgeDigest: context.judge.identity?.(),
    ...(task.runtimeSelectionRevision ? { runtimeSelectionRevision: task.runtimeSelectionRevision } : {}),
    ...(purpose === 'candidate' && task.selectedRuntimeBuildRequestId ? { builderBindingId: task.runtimeDelivery!.id } : {}),
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
  const requirements=purpose === 'candidate' ? task.analysis?.standardization?.requirements??[] : [];
  if(purpose === 'candidate' && authoredCases.some(c=>c.requirementIds?.some(id=>!requirements.some(r=>r.id===id))))bundleError('测试案例引用了当前方案之外的要求，请重新关联');
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
    let execution: Awaited<ReturnType<BundleRuntimeFactory>>;
    try { execution = await context.runtime({
      ...(purpose === 'baseline' ? {executionMode:'agent_project' as const} : {}),
      snapshot: bundle,
      services: candidate.services,
      configuration,
      signal,
    }); } catch (error) {
      incomplete = true;
      run.cases.push({id:evalCase.caseId,passed:false,reason:error instanceof Error ? error.message : 'Runtime 未就绪',failureStage:'RUNTIME'});
      await context.update(task.id,t=>{t.runs[t.runs.findIndex(item=>item.id===run.id)]=structuredClone(run);});
      if (signal.aborted) throw error;
      continue;
    }
    try{
    if (purpose === 'candidate') {
      requireBuilderEnvironment(task, execution.environmentSnapshot);
      if(reviewPlanEnvironment(task,execution.environmentSnapshot).status==='FAILED') bundleError('运行环境不满足当前方案的能力要求');
    }
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
      const observed = await executeEvaluationCase({runtime:execution.runtime,failureMode:'evidence',request:{
        runId: run.id,
        side: 'right',
        model: execution.model,
        variant,
        evalCase,
        signal,
      }});
      evidence = observed;
      const ids=authoredCases.find(c=>c.id===evalCase.caseId)?.requirementIds??[];
      const executionChecks=checkExecutionEvidence(evidence,{contentDigest:bundle.digest,members:bundle.members,...(purpose==='baseline'?{executionMode:'agent_project' as const}:{})});
      const evaluated=await evaluateTaskCase({evalCase,evidence,signal,executionChecks,judge:context.judge,judgeInput:{
        requirements:requirements.filter(r=>ids.includes(r.id)),tools:candidate.tools,
        onComposition:receipt=>{judgeComposition=receipt;},
        correlation:{taskId:task.id,attemptId:attempt.id,runId:run.id,requestId:attempt.requestId},
      }});
      const {verdict,methodResults,valid,judgeFailed}=evaluated;
      incomplete ||= evaluated.incomplete;
      const verifiedExecution=executionChecks.length>0&&executionChecks.filter(c=>c.id!=='execution.completed').every(c=>c.status==='PASS');
      if (run.judgeDigest !== context.judge.identity?.()) bundleError('Judge 配置在验收期间发生变化，请重新验收');
      run.cases.push({ id: evalCase.caseId, ...verdict, evidence, executionChecks, methodResults, ...(judgeComposition?{judgeComposition}:{}), ...(judgeFailed?{failureStage:'JUDGE' as const}:!valid ? {failureStage:verifiedExecution ? 'EXECUTION' as const : 'RUNTIME' as const} : {}) });
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
    // A failed restore contaminates the business test environment, even if its process was released.
    if(run.cases.at(-1)?.evidence?.metadata.caseState&&
      (run.cases.at(-1)!.evidence!.metadata.caseState as {status?:string}).status!=='COMPLETE')break;
  }
  signal.throwIfAborted();
  if(requirements.length){
    run.requirementCoverage=requirements.map(requirement=>{
      const checked=run.cases.filter(c=>c.requirementResults?.some(r=>r.id===requirement.id));
      const failed=checked.some(c=>c.requirementResults?.some(r=>r.id===requirement.id&&r.passed===false));
      const unknown=checked.some(c=>c.requirementResults?.some(r=>r.id===requirement.id&&r.passed===null));
      return {id:requirement.id,status:failed?'FAILED' as const:checked.length&&!unknown?'PASSED' as const:'UNVERIFIED' as const,caseIds:checked.map(c=>c.id)};
    });
    if(run.requirementCoverage.some(r=>r.status==='UNVERIFIED'))incomplete=true;
  }
  run.status = incomplete ? 'INCOMPLETE' : run.cases.length === cases.length && run.cases.every((c) => c.passed) ? 'PASSED' : 'FAILED';
  run.finishedAt = new Date().toISOString();
  await context.update(task.id, (t) => {
    t.runs[t.runs.findIndex((r) => r.id === run.id)] = run;
  });
  return run;
}
