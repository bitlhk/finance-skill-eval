"""Single application-control boundary for the Skill migration entry point.

Adapters supply observed capability results; Python owns business transitions.
The main Agent continues to choose its Skills, tools and editing strategy.
"""
from copy import deepcopy
from .artifacts import _prepared, _published, _executions, _delivery_reviews, _budget_requested

from .optimization import _select_recommended

from .state import MigrationControlError, attempt, _recoverable

from .lifecycle import _waiting, _complete, _failed, _startup, _recover, _runtime_ready, _runtime_requested, _runtime_wait, _control_ack, _reconcile_control, _register, _goal_events, _cancel_waiting, _control_requested, _control_not_sent

from .optimization import _evaluation_requested, _agent_context, _optimization_start, _evaluation_completed, _review_completed, _review_requested, _external_resume, _assert_optimization_inputs

def execute(request):
    task = deepcopy(request['task'])
    inputs = request.get('inputs') or {}
    standalone = {'register': _register, 'startup': _startup, 'runtime_ready': _runtime_ready, 'control_requested': _control_requested,
                  'goal_events': _goal_events, 'cancel_waiting': _cancel_waiting}
    if request['action'] in standalone:
        return {'task': task, 'value': standalone[request['action']](task, inputs)}
    current = attempt(task, request['attemptId'])
    handlers = {'waiting': _waiting, 'complete': _complete, 'failed': _failed,
                'evaluation_requested': _evaluation_requested, 'evaluation_completed': _evaluation_completed,
                'review_completed': _review_completed, 'agent_context': _agent_context, 'optimization_start': _optimization_start,
                'recover': _recover, 'recovery_eligible': lambda t, a, i: _recoverable(t, a, i.get('inputDigest')),
                'review_requested': _review_requested, 'runtime_requested': _runtime_requested, 'runtime_wait': _runtime_wait,
                'control_ack': _control_ack, 'reconcile_control': _reconcile_control, 'select_recommended': _select_recommended,
                'external_resume': _external_resume, 'assert_optimization_inputs': _assert_optimization_inputs,
                'control_not_sent': _control_not_sent, 'prepared': _prepared, 'published': _published,
                'executions': _executions, 'delivery_reviews': _delivery_reviews, 'budget_requested': _budget_requested}
    action = request['action']
    if action not in handlers:
        raise ValueError('Unknown migration task control action')
    value = handlers[action](task, current, inputs)
    return {'task': task, 'value': value}
