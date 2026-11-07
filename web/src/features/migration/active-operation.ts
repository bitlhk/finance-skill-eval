import type {BundleTask} from "../../../../contracts/platform/responses";

/** Keep observing the handoff between a finished conversation and its resumed optimization. */
export function pendingBudgetContinuation(task:BundleTask|null|undefined) {
  return task?.attempts.find(item=>item.budgetContinuation?.status==='PENDING');
}

export function activeOperationId(task:BundleTask|null|undefined) {
  const active=task?.attempts.find(item=>item.status==='RUNNING');
  const pending=pendingBudgetContinuation(task);
  const build=task?.runtimeBuildRequests?.find(item=>item.automatic&&['QUEUED','RUNNING'].includes(item.automatic.status));
  return active?.id ?? pending?.id ?? build?.requirements.requestId
    ?? (task?.startupCheck?.status==='RUNNING'?task.startupCheck.id:task?.rescoringOperation?.status==='RUNNING'?task.rescoringOperation.id:undefined);
}
