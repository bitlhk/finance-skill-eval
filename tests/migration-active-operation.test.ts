import {describe,expect,it} from 'vitest';
import type {BundleTask} from '../contracts/platform/responses';
import {activeOperationId,pendingBudgetContinuation} from '../web/src/features/migration/active-operation';

describe('migration operation handoff',()=>{
  it('keeps polling a pending continuation until it starts or fails',()=>{
    const task={attempts:[{id:'request',status:'COMPLETED',budgetContinuation:{ownerAttemptId:'owner',status:'PENDING'}}]} as BundleTask;
    expect(activeOperationId(task)).toBe('request');
    expect(pendingBudgetContinuation(task)?.id).toBe('request');
    task.attempts.push({id:'continued',status:'RUNNING'} as BundleTask['attempts'][number]);
    expect(activeOperationId(task)).toBe('continued');
    task.attempts[0]!.budgetContinuation!.status='STARTED';
    task.attempts[1]!.status='COMPLETED';
    expect(activeOperationId(task)).toBeUndefined();
    task.attempts[0]!.budgetContinuation!.status='FAILED';
    expect(activeOperationId(task)).toBeUndefined();
  });
});
