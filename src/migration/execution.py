"""Migration application execution, independent of HTTP and Agent framework I/O.

The main Agent chooses its work and capabilities. This program coordinates the
resulting calls, durable publication, evaluation and independent review. Every
I/O boundary uses existing adapters; continuation never recursively starts a
second task or creates a new conversation.
"""
from uuid import uuid4
from tasks.application_host import call, CapabilityError, dispatch
from .state import MigrationControlError, attempt as find_attempt, now, _runtime_changed
from .artifacts import candidate


def observation_scope(task, current):
    runs = [run for run in reversed(task['runs']) if run['phase'] == 'development' and run['status'] != 'RUNNING'][:5]
    prior = next((run for run in task['runs'] if run['id'] == current.get('runId') and run['phase'] == 'development'), None)
    if prior and not any(run['id'] == prior['id'] for run in runs):
        runs.insert(0, prior)
    drafts = []
    for item in reversed(task['attempts']):
        if item['id'] == current['id'] or item['kind'] != current['kind'] or item.get('baseCandidateId') != current.get('baseCandidateId'):
            continue
        if item['status'] in ('COMPLETED', 'CANCELLED'):
            break
        if item['status'] in ('FAILED', 'INTERRUPTED'):
            drafts.append(item['id'])
    return {'runIds': [run['id'] for run in runs], 'resumeDraftAttemptIds': drafts}


def agent_input(task, current, observed, context, drafts, reattach):
    value = {'mode': 'CHAT', 'source': observed['source'], 'base': observed['base'], 'goal': task['goal'],
             'target': task['target'], 'reviewAvailable': observed['reviewAvailable'], 'feedback': observed['feedback'],
             'evaluationAvailability': {'ready': not observed['evaluationIssues']}}
    for key in ('analysis',):
        if task.get(key) is not None:
            value[key] = task[key]
    for key in ('clarification', 'agentFollowup', 'agentCanReview'):
        if current.get(key) is not None:
            value[key] = current[key]
    for key in ('budgetContinuation', 'agentOptimization'):
        if context.get(key) is not None:
            value[key] = context[key]
    if task.get('inputKind') == 'agent_project':
        value['project'] = {'notes': task.get('projectNotes', '')}
        if task.get('preparations'):
            value['project']['preparation'] = task['preparations'][-1]['report']
    if observed['evaluationIssues']:
        value['evaluationAvailability']['reason'] = '；'.join(observed['evaluationIssues'])
    if observed.get('runtimePreparation'):
        value['runtimePreparation'] = observed['runtimePreparation']
    if drafts:
        value['resumeDraftAttemptIds'] = drafts
    if observed.get('checkpointRoot'):
        value['checkpointRoot'] = observed['checkpointRoot']
        value['taskSession'] = {}
        for source, target in (('sessionAnswer', 'answer'), ('sessionExecutionId', 'executionId'),
                               ('sessionResumePaused', 'resumePaused'), ('sessionRecoverCheckpoint', 'recoverCheckpoint')):
            if current.get(source) is not None:
                value['taskSession'][target] = current[source]
        if reattach:
            value['taskSession']['reattach'] = True
    return value


def run(request):
    task_id, current_id = request['taskId'], request['attemptId']
    phase, reattach = request.get('phase', 'development'), request.get('reattach', False)
    task = current = None

    def op(name, *, cleanup=False, **inputs):
        return call(name, {'taskId': task_id, 'attemptId': current_id, **inputs}, cleanup=cleanup)

    def transition(action, inputs=None, *, cleanup=False):
        return op('transition', action=action, inputs=inputs or {}, cleanup=cleanup)

    try:
        while True:
            task = yield op('load')
            current = find_attempt(task, current_id)
            if current['kind'] in ('ACCEPT', 'BASELINE'):
                yield op('evaluate', task=task, attempt=current, phase=phase,
                         purpose='baseline' if current['kind'] == 'BASELINE' else 'candidate')
                yield transition('complete')
                yield op('log_finished')
                return
            scope = observation_scope(task, current)
            observed = yield op('observe', task=task, attempt=current, runIds=scope['runIds'])
            response = yield transition('agent_context')
            task, context = response['task'], response['value']
            current = find_attempt(task, current_id)
            yield op('progress', message='主 Agent 正在处理迁移任务')
            result = yield op('agent', input=agent_input(task, current, observed, context, scope['resumeDraftAttemptIds'], reattach))
            old_goal, old_target = task['goal'], task['target']
            task = yield op('load')
            active = (find_attempt(task, current['agentOptimizationOwnerId']).get('optimization')
                      if current.get('agentOptimizationOwnerId') else context.get('activeOptimization'))
            if task['goal'] != old_goal or task['target'] != old_target:
                result['deliveryReviews'] = []
                if active:
                    active['status'] = 'STOPPED'
                    result['evaluationRequested'] = False
                    result.pop('reviewRequested', None)
                    result.pop('optimizationRequest', None)
            if result['status'] == 'WAITING':
                yield transition('waiting', {'interactions': result.get('interactions', [])})
                return
            if result['status'] != 'PRODUCED':
                raise MigrationControlError(result.get('reason') or 'Agent 需要补充信息')
            if not (result.get('message') or '').strip():
                raise MigrationControlError('Agent 没有返回有效回答')
            if result.get('files') is None:
                raise MigrationControlError('Agent 没有返回工作区文件')
            frozen = yield op('freeze', task=task, base=observed['base'], result=result)
            revision, executions = frozen['revision'], frozen['executions']
            if current.get('prepareProject'):
                if any(result.get(key) for key in ('budgetRequest', 'evaluationRequested', 'reviewRequested', 'optimizationRequest', 'deliveryReviews')):
                    raise MigrationControlError('工程准备包含尚未处理的评测或审查请求，请先完成准备再继续')
                preparation = {'id': 'candidate-' + str(uuid4()), 'attemptId': current_id, 'digest': revision['digest'], 'createdAt': now(),
                    'report': {'summary': result['message'], 'skills': [], 'entrypoints': [],
                        'missing': ['未单独提取结构化清单；请以 Agent 的准备说明和实际基线运行核对。'],
                        'baselinePlan': '请依据 Agent 的准备说明配置并实际运行原工程基线。'},
                    'executions': executions, 'baselineStatus': 'NOT_EVALUATED'}
                yield op('save_snapshot', revision=revision, id=preparation['id'], parent=(task.get('preparations') or [{}])[-1].get('id') or 'source')
                yield transition('prepared', {'preparation': preparation})
                return
            if result.get('budgetRequest'):
                owner = context.get('continuationOwner')
                if (not owner or result['budgetRequest']['ownerAttemptId'] != owner['id'] or current.get('agentFollowup')
                        or any(result.get(key) for key in ('evaluationRequested', 'reviewRequested', 'optimizationRequest', 'deliveryReviews'))
                        or revision['digest'] != observed['base']['digest'] or executions):
                    raise MigrationControlError('预算续跑请求与当前任务不一致，请重新确认；本轮不会自动继续')
                yield transition('budget_requested', {'request': result['budgetRequest']})
                yield op('budget_continuation')
                return
            baseline_id = current.get('optimizationBaselineRunId') if current.get('optimizationGoal') else (result.get('optimizationRequest') or {}).get('baselineRunId')
            baseline = yield op('evaluation_view', task=task, runId=baseline_id)
            response = yield transition('optimization_start', {'optimizationRequest': result.get('optimizationRequest'),
                'evaluationRequested': result.get('evaluationRequested'), 'activeOptimization': active,
                'reviewAvailable': observed['reviewAvailable'], 'baseDigest': observed['base']['digest'], 'baselineEvaluation': baseline})
            starting = response['value']
            existing = next((item for item in task['candidates'] if item['id'] == task.get('currentCandidateId')), None)
            delivery = result.get('deliveryTools')
            delivery_changed = delivery is not None and (existing is None or any(
                delivery.get(key, []) != existing.get(key, []) for key in ('services', 'tools')))
            if revision['digest'] != observed['base']['digest'] or delivery_changed or result.get('evaluationRequested') and not task.get('currentCandidateId'):
                diff = yield op('diff', before=observed['base']['files'], after=revision['files'])
                value = candidate(task, current, result, revision, executions, diff)
                parent = current.get('baseCandidateId') or (task.get('preparations') or [{}])[-1].get('id') or 'source'
                yield op('save_snapshot', revision=revision, id=value['id'], parent=parent)
                yield transition('published', {'candidate': value, 'expectedCandidateId': task.get('currentCandidateId')})
            elif executions:
                yield transition('executions', {'executions': executions})
            if result.get('deliveryReviews'):
                reviews = yield op('validate_delivery_reviews', result=result, revision=revision, observed=observed, executions=executions)
                yield transition('delivery_reviews', {'reviews': reviews['reviews'], 'digest': revision['digest'], 'scopeDigest': reviews['scopeDigest']})
            if result.get('runtimePreparationRequested'):
                if any(result.get(key) for key in ('evaluationRequested', 'reviewRequested', 'optimizationRequest', 'budgetRequest')):
                    raise MigrationControlError('运行环境准备与评测或审查不能同时提交，请先等待运行环境就绪')
                next_id = yield op('runtime_preparation', request=result['runtimePreparationRequested'])
                if next_id:
                    current_id, phase, reattach = next_id, 'development', False
                    continue
                return
            if result.get('evaluationRequested'):
                loop = starting or active
                response = yield transition('evaluation_requested', {'startingOptimization': starting,
                    'optimizationOwnerId': (current.get('agentOptimizationOwnerId') or current_id) if loop else None,
                    'candidateDigest': revision['digest'], 'runtimeChanged': _runtime_changed(task, current.get('runtimeChange'), observed['facts']),
                    'evaluationIssues': observed['evaluationIssues']})
                if response['value']['next'] == 'done':
                    return
                owner_id = response['value'].get('optimizationOwnerId')
                yield op('evaluate', task=response['task'], attempt=find_attempt(response['task'], current_id), phase='development', purpose='candidate')
                previous_id = (loop.get('workingEvaluationId') or loop.get('baselineEvaluationId')) if loop else None
                evaluated = yield op('evaluation_result', previousRunId=previous_id)
                if not evaluated['run'] or evaluated['run']['status'] == 'RUNNING':
                    raise MigrationControlError('开发集评测尚未完成')
                before, after, change = evaluated.get('before'), evaluated['after'], current.get('runtimeChange')
                context_change = None
                if (loop and _runtime_changed(evaluated['task'], change, evaluated['facts']) and before and before.get('criteriaDigest')
                        and before['criteriaDigest'] == after.get('criteriaDigest') and before.get('protocolDigest') != after.get('protocolDigest')):
                    context_change = {'beforeProtocolDigest': before['protocolDigest'], 'afterProtocolDigest': after['protocolDigest'],
                        'criteriaDigest': before['criteriaDigest'], 'reference': change['reference'], 'reason': change['reason']}
                response = yield transition('evaluation_completed', {'run': evaluated['run'], 'optimizationOwnerId': owner_id,
                    'contextChange': context_change, 'repetitionsComplete': evaluated['repetitionsComplete']})
                current_id, phase, reattach = response['value']['attemptId'], 'development', False
                continue
            if result.get('reviewRequested'):
                response = yield transition('review_requested', {'request': result['reviewRequested']})
                review = yield op('review', task=response['task'], instruction=response['value'])
                response = yield transition('review_completed', review)
                current_id, phase, reattach = response['value']['attemptId'], 'development', False
                continue
            yield transition('complete')
            yield op('log_finished')
            return
    except Exception as error:
        detail = error.detail if isinstance(error, CapabilityError) else {'message': str(error), 'name': type(error).__name__}
        facts = yield op('failure_facts', cleanup=True)
        unknown = not detail.get('aborted') and (detail.get('name') == 'MigrationAgentUnavailable'
                    or detail.get('executionUnknown') or (current or {}).get('sessionResumePaused'))
        yield transition('failed', {'aborted': detail.get('aborted', False), 'closing': detail.get('closing', False),
            'executionUnknown': bool(unknown), 'retryInteraction': not detail.get('aborted') and facts['retryInteraction'],
            'error': detail.get('message') or '操作失败'}, cleanup=True)
        yield op('log_finished', error=detail, cleanup=True)


def recover(request):
    """Verify remote execution before reattachment or checkpoint takeover."""
    task_id = request['taskId']
    task = yield call('load', {'taskId': task_id})
    current = task['attempts'][-1] if task['attempts'] else None
    if not current or not current.get('sessionExecutionId'):
        return
    scope = {'taskId': task_id, 'attemptId': current['id']}
    eligible = yield call('inspect', {**scope, 'action': 'recovery_eligible'})
    if not eligible:
        return
    try:
        observed = yield call('execution_observation', {**scope, 'executionId': current['sessionExecutionId']})
    except CapabilityError:
        return  # Network failure does not prove that a remote execution stopped.
    response = yield call('transition', {**scope, 'action': 'recover', 'inputs': {
        **observed, 'executionId': current['sessionExecutionId'], 'inputRunId': current.get('runId')}})
    if response['value']['next'] == 'agent':
        yield call('continue_execution', {**scope, 'task': response['task'], 'reattach': response['value']['reattach']})


def execute(request):
    return dispatch(request, {"run": run, "recover": recover})
