import type { BundleTask } from '../../../../src/migration/tasks/domain/task-model';

export type StageProgress = { status: 'pending' | 'completed' | 'running' | 'attention' | 'ready'; label: string; available: boolean };
const stable = (value: unknown): string => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

/** Viewing a page is independent of completing work. Only persisted evidence advances progress. */
export function migrationProgress(task: BundleTask | null, checkingRuntime = false): StageProgress[] {
  const candidate = task?.candidates.find(item => item.id === task.currentCandidateId);
  const configured = Boolean(task?.configuration && !['PENDING', 'STALE'].includes(task.builderStatus ?? ''));
  const selected = Boolean(configured && (task?.configurationConfirmed || task?.builderStatus === 'BOUND'
    || task?.startupCheckCurrent || task?.verifiedRunId));
  const prepared = Boolean(candidate && configured && task?.candidatePlanCurrent !== false && task?.runtimeReviewCurrent && task.runtimeReview?.status === 'PASSED');
  const stages: StageProgress[] = [
    { status: task ? 'completed' : 'pending', label: task ? '已导入' : '待上传', available: true },
    { status: task?.analysis ? (task.analysis.missing.length || task.analysis.plan?.unresolvedQuestions.length ? 'attention' : task.planApproved ? 'completed' : 'pending') : 'pending', label: task?.analysis ? (task.analysis.missing.length || task.analysis.plan?.unresolvedQuestions.length ? '待补充' : task.planApproved ? '已确认' : '待确认方案') : '待分析', available: Boolean(task) },
    { status: candidate ? task?.candidatePlanCurrent === false ? 'attention' : 'completed' : 'pending', label: candidate ? task?.candidatePlanCurrent === false ? '需按新方案生成' : '已生成' : '待生成', available: Boolean(candidate || task?.planApproved) },
    { status: prepared ? 'completed' : 'pending', label: prepared ? '能力已核对' : selected ? '已选择，待检查' : '待选择', available: Boolean(candidate && task?.candidatePlanCurrent !== false) },
    { status: 'pending', label: task?.startupCheck && !task.startupCheckCurrent ? '需重新检查' : '待检查', available: Boolean(candidate && selected && task?.candidatePlanCurrent !== false) },
    { status: task?.verifiedRunId ? 'completed' : 'pending', label: task?.verifiedRunId ? '已通过' : '待验收', available: Boolean(candidate && selected && task?.candidatePlanCurrent !== false) },
    { status: task?.verifiedRunId ? 'ready' : 'pending', label: task?.verifiedRunId ? '可下载' : '待验收通过', available: Boolean(candidate) },
  ];
  if (!task) return stages;
  if(task.runtimeReviewCurrent && task.runtimeReview?.status==='FAILED') stages[3]={...stages[3]!,status:'attention',label:'不满足方案要求'};
  if (['PENDING', 'STALE'].includes(task.builderStatus ?? '')) stages[3] = { ...stages[3]!, status: 'attention', label: task.builderStatus === 'STALE' ? '环境已失效' : '待交付' };
  const check = task.startupCheckCurrent ? task.startupCheck : undefined;
  if (check) stages[4] = { ...stages[4]!, status: check.status === 'PASSED' ? 'completed' : check.status === 'RUNNING' ? 'running' : 'attention',
    label: { PASSED: '已通过', RUNNING: '检查中', FAILED: '未通过', INTERRUPTED: '已中断' }[check.status] };
  if (checkingRuntime) stages[4] = { ...stages[4]!, status: 'running', label: '检查中' };
  const run = [...task.runs].reverse().find(item => item.candidateId === task.currentCandidateId
    && item.judgeDigest === task.currentJudgeDigest && item.runtimeSelectionRevision === task.runtimeSelectionRevision
    && item.builderBindingId === (task.selectedRuntimeBuildRequestId ? task.runtimeDelivery?.id : undefined)
    && stable(item.configuration) === stable(task.configuration) && stable(item.suite) === stable(task.suite));
  if (!task.verifiedRunId && run && configured && task.candidatePlanCurrent!==false) stages[5] = { ...stages[5]!,
    status: run.status === 'RUNNING' ? 'running' : run.status === 'PASSED' ? 'pending' : 'attention',
    label: { RUNNING: '验收中', PASSED: '待完整验收', FAILED: '未通过', INCOMPLETE: '未完成', CANCELLED: '已取消' }[run.status] };
  for (const [index, kinds] of [[0, ['PREPARE','BASELINE']], [1, ['ANALYZE']], [2, ['GENERATE', 'REPAIR']], [5, ['ACCEPT','OPTIMIZE']]] as const) {
    const attempt = [...task.attempts].reverse().find(item => (kinds as readonly string[]).includes(item.kind));
    if (!attempt || attempt.status === 'COMPLETED' || attempt.baseCandidateId !== task.currentCandidateId) continue;
    if (index === 5 && attempt.status!=='WAITING' && (task.verifiedRunId || run && run.id !== attempt.runId)) continue;
    stages[index] = { ...stages[index]!, status: attempt.status === 'RUNNING' ? 'running' : 'attention',
      label: { RUNNING: '进行中', WAITING:'等待外部调整',FAILED: '失败', CANCELLED: '已取消', INTERRUPTED: '已中断' }[attempt.status] };
  }
  return stages;
}
