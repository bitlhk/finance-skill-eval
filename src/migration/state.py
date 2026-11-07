"""Shared migration execution identities, clocks and budget accounting."""
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

class MigrationControlError(ValueError):
    status = 409

    def __init__(self, message, status=409):
        super().__init__(message)
        self.status = status

def now():
    return datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')

def milliseconds(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000

def remaining(deadline):
    return None if deadline is None else max(0, milliseconds(deadline) - milliseconds(now()))

def expired(deadline):
    return deadline is not None and remaining(deadline) <= 0

def attempt(task, ident):
    result = next((item for item in task['attempts'] if item['id'] == ident), None)
    if result is None:
        raise MigrationControlError('任务执行记录不存在')
    return result

def owner(task, current):
    return attempt(task, current.get('agentOptimizationOwnerId', current['id']))

def pause_budget(task, current):
    root = owner(task, current)
    loop = root.get('optimization')
    if ((loop and loop['status'] == 'RUNNING' and loop.get('deadlineAt')) or
            (root.get('optimizationBudgetStartedAt') and not loop)) and not root.get('optimizationBudgetPausedAt'):
        root['optimizationBudgetPausedAt'] = now()

def resume_budget(task, current):
    root = owner(task, current)
    paused = root.pop('optimizationBudgetPausedAt', None)
    if not paused:
        return
    elapsed = max(0, milliseconds(now()) - milliseconds(paused))
    loop = root.get('optimization')
    if loop and loop['status'] == 'RUNNING' and loop.get('deadlineAt'):
        loop['deadlineAt'] = datetime.fromtimestamp((milliseconds(loop['deadlineAt']) + elapsed) / 1000,
                                                    timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    elif not loop:
        root['optimizationBudgetPausedMs'] = root.get('optimizationBudgetPausedMs', 0) + elapsed

def followup(task, text, message, *, optimization_owner=None, can_review=False, persisted=False, input_digest=None):
    result = {'id': 'attempt-' + str(uuid4()), 'kind': 'CHAT', 'key': str(uuid4()),
              'requestDigest': str(uuid4()), 'baseCandidateId': task.get('currentCandidateId'),
              'agentRunId': 'agent-' + str(uuid4()), 'agentFollowup': True,
              'clarification': text, 'status': 'RUNNING', 'startedAt': now(), 'message': message}
    if optimization_owner:
        result['agentOptimizationOwnerId'] = optimization_owner
    if can_review:
        result['agentCanReview'] = True
    if persisted:
        result.update(sessionExecutionId=str(uuid4()), sessionInputDigest=input_digest)
    return result

def finish(current, message):
    current.update(status='COMPLETED', finishedAt=now(), message=message)
    for key in ('sessionControl', 'sessionResumePaused', 'sessionAnswer', 'waitingInteractionIds'):
        current.pop(key, None)

def _runtime_changed(task, change, facts):
    return bool(change and change.get('configurationDigest') == facts.get('configurationDigest')
                and change.get('selectionRevision') == task.get('runtimeSelectionRevision')
                and change.get('bindingId') == ((task.get('runtimeDelivery') or {}).get('id') if task.get('selectedRuntimeBuildRequestId') else None))

def _recoverable(task, current, input_digest):
    return bool(current and current['status'] in ('RUNNING', 'INTERRUPTED') and current['kind'] == 'CHAT'
                and (current.get('sessionControl') or {}).get('status') not in ('PAUSED', 'RECOVERABLE')
                and current.get('sessionExecutionId') and current.get('agentRunId') and current.get('sessionInputDigest')
                and not current.get('autoRetest') and not current.get('agentEvaluation') and not current.get('agentReview')
                and current.get('baseCandidateId') == task.get('currentCandidateId') and current['sessionInputDigest'] == input_digest)
