import {canonicalSha256} from '../../../shared/json-canonicalization.js';
import {bundleError,requireTaskBuilderBinding,type BundleTask,type BundleAttempt,type BundleRun} from '../domain/task-model.js';

export const waitingOptimization=(task:BundleTask)=>task.attempts.find(a=>a.kind==='OPTIMIZE'&&a.status==='WAITING'&&a.optimization?.waiting);

export function assertOptimizationInputs(task:BundleTask,attempt:BundleAttempt){
  const frozen=attempt.optimizationInputs,loop=attempt.optimization;
  if(!frozen||!loop||task.currentCandidateId!==loop.baseline.id)bundleError('优化基线已变化，请保留历史后重新发起');
  if(frozen.suiteDigest!==canonicalSha256(task.suite??null)||frozen.planDigest!==canonicalSha256(task.analysis??null))
    bundleError('优化目标、方案或测试集已变化，不能继续原任务');
}

/** Restores the complete evaluated solution, not just the Skill version. Historical deployments remain registered. */
export function activateOptimizationRun(task:BundleTask,run:BundleRun){
  task.configuration=structuredClone(run.configuration);
  task.runtimeSelectionRevision=run.runtimeSelectionRevision;
  if(run.builderBindingId){
    const delivery=task.runtimeDeliveries?.find(d=>d.id===run.builderBindingId)??(task.runtimeDelivery?.id===run.builderBindingId?task.runtimeDelivery:undefined);
    if(!delivery)bundleError('评测对应的 Runtime 交付记录缺失');
    task.runtimeDelivery=delivery;task.selectedRuntimeBuildRequestId=delivery.requestId;
  }else delete task.selectedRuntimeBuildRequestId;
}

export function prepareOptimizationResume(task:BundleTask,attempt:BundleAttempt,judgeDigest?:string){
  assertOptimizationInputs(task,attempt);
  const loop=attempt.optimization!,waiting=loop.waiting;
  if(attempt.status!=='WAITING'||loop.status!=='WAITING'||!waiting)bundleError('此优化任务不处于等待状态');
  if(attempt.optimizationInputs!.judgeDigest!==judgeDigest)bundleError('评估器已变化，不能继续原优化任务');
  if(waiting.kind==='INPUT')bundleError('该诊断需要重新确认评测方案，请先停止本任务后调整方案');
  const previous=task.runs.find(r=>r.id===loop.workingEvaluationId);
  if(!previous||!task.configuration)bundleError('缺少恢复优化所需的运行配置或基线');
  if(waiting.kind==='BUILDER'){
    requireTaskBuilderBinding(task);
    const request=task.runtimeBuildRequests?.find(r=>r.requirements.requestId===waiting.requestId);
    if(!request||request.optimizationAttemptId!==attempt.id||request.candidateId!==waiting.candidate.id
      ||task.selectedRuntimeBuildRequestId!==request.requirements.requestId||task.runtimeDelivery?.requestId!==request.requirements.requestId)
      bundleError('请先接收与本轮实验版本匹配的 Builder 交付');
    if(task.runtimeDelivery.id===previous.builderBindingId)bundleError('需要新的 Builder 交付');
  }else if(canonicalSha256(task.configuration)===previous.configurationDigest)bundleError('运行配置尚未调整');
  if(task.runs.some(r=>r.phase==='holdout'&&r.suiteDigest===attempt.optimizationInputs!.suiteDigest))bundleError('留出集已消费，不能继续优化');
  loop.status='RUNNING';loop.deadlineAt=new Date(Date.now()+waiting.remainingMs).toISOString();
  delete loop.finishedAt;delete loop.reason;
  attempt.status='RUNNING';delete attempt.finishedAt;delete attempt.error;attempt.message='外部调整已就绪，继续本轮复测与审查';
}
