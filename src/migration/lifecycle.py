"""Migration task lifecycle, interaction, recovery and Runtime handoff."""
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

from .state import MigrationControlError, now, milliseconds, remaining, expired, attempt, owner, pause_budget, resume_budget, followup, finish, _runtime_changed, _recoverable

from .optimization import _resume_optimization

def _goal_events(task, inputs):
    for event in inputs['events']:
        if event['sequence'] <= task.get('goalEventSequence', 0):
            continue
        payload = event['payload']
        source = next((item for item in task['attempts'] if item['id'] == payload['attemptId']), None)
        task['goalEventSequence'] = event['sequence']
        if not source or source.get('finishedAt') and milliseconds(event['createdAt']) > milliseconds(source['finishedAt']):
            continue
        changed = task['goal'] != payload['goal'] or 'target' in payload and task.get('target') != payload['target']
        task['goal'] = payload['goal']
        if 'target' in payload:
            task['target'] = payload['target']
        if changed:
            for current in task['attempts']:
                loop = current.get('optimization')
                if not loop or loop['status'] not in ('RUNNING', 'WAITING', 'INTERRUPTED'):
                    continue
                loop.update(status='STOPPED', reason='任务目标已变更，已保留工作和证据；请按新目标重新发起优化', finishedAt=now())
                loop.pop('waiting', None)
                current.pop('agentOptimizationRemainingMs', None)
                if current['status'] == 'WAITING':
                    current.update(status='INTERRUPTED', message=loop['reason'])


def _cancel_waiting(task, inputs):
    for current in task['attempts']:
        if current.get('runtimeWait') and current['status'] == 'WAITING':
            current.update(status='CANCELLED', finishedAt=now(), message='已取消等待运行环境，工作和记录已保留')
            current.pop('runtimeWait', None)
        if current['status'] == 'WAITING' and current.get('waitingInteractionIds'):
            current.update(status='CANCELLED', finishedAt=now(), message='已取消等待，工作区和对话已保留')
            current.pop('waitingInteractionIds', None)
            current.pop('sessionAnswer', None)
    waiting = next((item for item in task['attempts'] if item['kind'] == 'OPTIMIZE' and item['status'] == 'WAITING'
                    and (item.get('optimization') or {}).get('waiting')), None)
    if not waiting:
        return
    loop = waiting['optimization']
    run = next((item for item in task['runs'] if item['id'] == loop['bestEvaluationId']), None)
    if run:
        task['configuration'] = deepcopy(run['configuration'])
        if run.get('runtimeSelectionRevision') is None:
            task.pop('runtimeSelectionRevision', None)
        else:
            task['runtimeSelectionRevision'] = run['runtimeSelectionRevision']
        if run.get('builderBindingId'):
            delivery = next((item for item in task.get('runtimeDeliveries', []) if item['id'] == run['builderBindingId']), None)
            delivery = delivery or (task.get('runtimeDelivery') if (task.get('runtimeDelivery') or {}).get('id') == run['builderBindingId'] else None)
            if not delivery:
                raise MigrationControlError('评测对应的 Runtime 交付记录缺失')
            task.update(runtimeDelivery=delivery, selectedRuntimeBuildRequestId=delivery['requestId'])
        else:
            task.pop('selectedRuntimeBuildRequestId', None)
    waiting.update(status='CANCELLED', finishedAt=now(), message='已停止等待，实验和 Builder 交付历史已保留')
    loop.update(status='CANCELLED', reason=waiting['message'], finishedAt=waiting['finishedAt'])


def _control_requested(task, inputs):
    current = next((item for item in reversed(task['attempts']) if item['status'] == 'RUNNING'
                    and item['kind'] in ('PREPARE', 'ANALYZE', 'GENERATE', 'REPAIR', 'CHAT') and item.get('sessionExecutionId')), None)
    if not current or current.get('agentEvaluation') == 'RUNNING' or current.get('agentReview') == 'RUNNING':
        raise MigrationControlError('当前没有可暂停或继续的 Agent 会话')
    action, status = inputs['action'], (current.get('sessionControl') or {}).get('status')
    if action == 'pause' and status:
        raise MigrationControlError('会话已暂停或控制状态待确认')
    if action == 'resume' and status != 'PAUSED':
        raise MigrationControlError('当前会话不处于已确认的暂停状态')
    current['sessionControl'] = {'status': 'PAUSING' if action == 'pause' else 'RESUMING', 'updatedAt': now()}
    return current['id']


def _control_not_sent(task, current, inputs):
    if current['status'] == 'RUNNING':
        current['sessionControl'] = {'status': 'PAUSED' if inputs['action'] == 'resume' else 'UNKNOWN', 'updatedAt': now()}


def _waiting(task, current, inputs):
    ids = []
    for item in inputs.get('interactions', []):
        if isinstance(item, dict):
            ident = item.get('interaction_id', item.get('id'))
            if isinstance(ident, str) and ident:
                ids.append(ident)
    if not ids:
        raise MigrationControlError('Agent 等待用户回答，但没有有效的问题标识')
    current.update(status='WAITING', waitingInteractionIds=ids, message='等待你回答问题')
    current.pop('sessionAnswer', None)
    pause_budget(task, current)

def _complete(task, current, inputs):
    loop = owner(task, current).get('optimization') if current.get('agentOptimizationOwnerId') else None
    if loop and loop['status'] == 'RUNNING':
        stopped = loop['stage'] == 'ADJUSTMENT'
        loop.update(status='STOPPED' if stopped else 'INTERRUPTED',
                    reason='Agent 已结束当前优化，保留工作与已审查结果' if stopped else '本轮尚未完成，已保留工作与证据')
        if stopped:
            loop['finishedAt'] = now()
        else:
            value = remaining(loop.get('deadlineAt'))
            if value is not None:
                owner(task, current)['agentOptimizationRemainingMs'] = value
    retest = next((run for run in task['runs'] if run['id'] == current.get('runId')), None) if current.get('autoRetest') else None
    message = ('联合验收已结束，请查看验收结论' if current['kind'] == 'ACCEPT' else
               '修复后的开发集复测已通过' if retest and retest['status'] == 'PASSED' else
               '修复后的开发集复测仍有失败，请查看证据并继续处理' if retest and retest['status'] == 'FAILED' else
               '修复后的开发集复测未完成，请查看缺失证据或运行问题' if retest else '本阶段已完成')
    finish(current, message)

def _failed(task, current, inputs):
    aborted, closing, unknown = inputs.get('aborted', False), inputs.get('closing', False), inputs.get('executionUnknown', False)
    if current.get('sessionControl') or unknown and current.get('sessionExecutionId'):
        current['sessionControl'] = {'status': 'UNKNOWN', 'updatedAt': now()}
    if inputs.get('retryInteraction'):
        current.update(status='WAITING', message='回答尚未被接收，请检查内容后重试', error=inputs.get('error') or '回答未被接收')
        current.pop('sessionAnswer', None)
        current.pop('finishedAt', None)
        return
    root = owner(task, current)
    loop = root.get('optimization')
    if loop and loop['status'] == 'RUNNING':
        loop.update(status='CANCELLED' if aborted and not closing else 'INTERRUPTED', reason='本轮尚未完成，已保留工作与证据')
        value = remaining(loop.get('deadlineAt'))
        if loop['status'] == 'INTERRUPTED' and value is not None:
            root['agentOptimizationRemainingMs'] = value
        elif loop['status'] == 'CANCELLED':
            loop['finishedAt'] = now()
    waiting = (current.get('optimization') or {}).get('waiting') or {}
    if aborted and closing and (current.get('optimization') or {}).get('status') == 'WAITING' and waiting.get('kind') == 'BUILDER' and waiting.get('requestId'):
        current.update(status='WAITING', message='服务关闭，Runtime 新建及本轮验证待恢复')
        return
    current.update(status=('INTERRUPTED' if closing else 'CANCELLED') if aborted else 'INTERRUPTED' if unknown else 'FAILED',
                   finishedAt=now(), error=inputs.get('error') or '操作失败',
                   message=('服务关闭，本次执行已中断；请核对状态后恢复' if closing else '操作已取消') if aborted else
                   'Agent 运行连接中断，执行结果尚未确认；请核对状态后恢复' if unknown else '操作未完成')
    if not closing and not unknown:
        current.pop('sessionAnswer', None)
    for run in task['runs']:
        if run['status'] == 'RUNNING':
            run.update(status='CANCELLED' if aborted and not closing else 'INCOMPLETE', finishedAt=now())

def _startup(task, inputs):
    original = deepcopy(task)
    builds, basic = [], []
    check = task.get('startupCheck') or {}
    if check.get('status') == 'RUNNING':
        check.update(status='INTERRUPTED', message='服务重启，启动检查中断，请重新检查')
    rescore = task.get('rescoringOperation') or {}
    if rescore.get('status') == 'RUNNING':
        rescore.update(status='INTERRUPTED', finishedAt=now(), error='服务重启，重新评判已中断；原始运行记录仍然保留。')
    for current in task['attempts']:
        if current['status'] != 'RUNNING':
            continue
        if current['kind'] == 'CHAT' and current.get('runtimeWait'):
            current.update(status='WAITING', message='服务重启，运行环境准备待核对')
            pause_budget(task, current)
            continue
        loop = current.get('optimization')
        if loop and loop['status'] == 'WAITING':
            current.update(status='WAITING', message=loop.get('reason') or '等待外部调整')
            continue
        current.update(status='INTERRUPTED', message='服务已重启，本次操作中断；可重新发起', finishedAt=now())
        if current.get('sessionControl') or current.get('sessionExecutionId'):
            current['sessionControl'] = {'status': 'UNKNOWN', 'updatedAt': now()}
        if loop and loop['status'] == 'RUNNING':
            resume_budget(task, current)
            loop.update(status='INTERRUPTED', reason='服务重启，优化中断，实验候选未自动采纳')
            value = remaining(loop.get('deadlineAt'))
            if current['kind'] == 'CHAT' and value is not None:
                current['agentOptimizationRemainingMs'] = value
    for run in task['runs']:
        if run['status'] == 'RUNNING':
            run.update(status='INCOMPLETE', finishedAt=now())
    for request in task.get('runtimeBuildRequests', []):
        automatic = request.get('automatic') or {}
        startup = automatic.get('startupCheck') or {}
        if startup.get('status') == 'RUNNING':
            startup.update(status='INTERRUPTED', finishedAt=now())
        current = next((a for a in task['attempts'] if a['id'] == request.get('optimizationAttemptId') and a['status'] == 'WAITING'), None)
        waiting = (current.get('optimization') or {}).get('waiting') or {} if current else {}
        valid_owner = bool(current and (
            (current.get('runtimeWait') or {}).get('requestId') == request['requirements']['requestId'] and request['candidateId'] == task.get('currentCandidateId')
            or current.get('optimization', {}).get('status') == 'WAITING' and waiting.get('kind') == 'BUILDER'
            and waiting.get('requestId') == request['requirements']['requestId'] and waiting['candidate']['id'] == request['candidateId']
            and waiting['candidate']['digest'] == request['candidateDigest']))
        selected = request['requirements']['requestId'] == task.get('selectedRuntimeBuildRequestId')
        resume = False
        if automatic.get('status') in ('QUEUED', 'RUNNING', 'INTERRUPTED'):
            automatic.update(status='INTERRUPTED', error='服务重启，构建状态待恢复')
            resume = valid_owner or not request.get('optimizationAttemptId') and request['candidateId'] == task.get('currentCandidateId')
        elif automatic.get('status') == 'SUCCEEDED':
            resume = valid_owner
        if resume and selected and automatic.get('trustReference') and not request['requirements'].get('rebuild'):
            item = {'taskId': task['id'], 'requestId': request['requirements']['requestId'], 'trustReference': automatic['trustReference']}
            if valid_owner:
                item['ownerAttemptId'] = current['id']
            builds.append(item)
        if not request.get('optimizationAttemptId') and automatic.get('status') == 'SUCCEEDED' and automatic.get('basicValidation', {}).get('status') in ('PENDING', 'STARTED'):
            basic.append({'taskId': task['id'], 'requestId': request['requirements']['requestId']})
    last = task['attempts'][-1] if task['attempts'] else None
    if last and last['status'] == 'INTERRUPTED' and last.get('agentOptimizationOwnerId'):
        root = owner(task, last)
        loop = root.get('optimization')
        if loop and loop['status'] == 'RUNNING':
            resume_budget(task, last)
            loop.update(status='INTERRUPTED', reason='服务重启，当前优化回合状态未确认；已保留工作和证据')
            value = remaining(loop.get('deadlineAt'))
            if value is not None:
                root['agentOptimizationRemainingMs'] = value
    return {'changed': task != original, 'recoverSession': _recoverable(task, last, inputs.get('inputDigest')),
            'recoverBuilds': builds, 'recoverBasic': basic}

def _recover(task, current, inputs):
    if not _recoverable(task, current, inputs['inputDigest']) or current['sessionExecutionId'] != inputs['executionId']:
        return {'next': 'done'}
    status, paused, record = inputs['status'], inputs.get('paused') or {}, inputs.get('round') or {}
    available = status['available']
    if not available and (status['state'] == 'failed' or paused.get('status') == 'paused' or not record.get('recoverable') or record.get('status') not in ('running', 'finished')):
        if current['status'] == 'RUNNING':
            current.update(status='INTERRUPTED', message='原执行已中断，工作与上下文已保留，请核对后继续',
                           sessionControl={'status': 'RECOVERABLE' if paused.get('status') == 'paused' else 'UNKNOWN', 'updatedAt': now()})
        return {'next': 'done'}
    current.update(status='RUNNING', message='正在重新连接已有执行' if available else '正在从已保存的上下文和工程接管任务')
    if not available:
        current.update(sessionExecutionId=str(uuid4()), sessionRecoverCheckpoint=True)
        current.pop('sessionResumePaused', None)
    for key in ('sessionControl', 'finishedAt', 'error'):
        current.pop(key, None)
    root = owner(task, current)
    loop = root.get('optimization')
    if loop and loop['status'] == 'INTERRUPTED':
        loop['status'] = 'RUNNING'
        loop.pop('finishedAt', None)
        if root.get('agentOptimizationRemainingMs') is not None:
            loop['deadlineAt'] = datetime.fromtimestamp((milliseconds(now()) + max(0, root['agentOptimizationRemainingMs'])) / 1000,
                                                        timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    resume_budget(task, current)
    return {'next': 'agent', 'attemptId': current['id'], 'reattach': available}

def _runtime_ready(task, inputs):
    ident = inputs['requestId']
    request = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == ident), None)
    current = next((item for item in task['attempts'] if item['kind'] == 'CHAT' and (item.get('runtimeWait') or {}).get('requestId') == ident), None)
    if not request or not current or current['status'] != 'WAITING':
        child = next((item for item in task['attempts'] if item['key'] == 'runtime-ready-' + ident), None)
        return {'next': 'agent', 'attemptId': child['id']} if child and child['status'] == 'RUNNING' else {'next': 'done'}
    delivery = task.get('runtimeDelivery') or {}
    if (inputs['builderStatus'] != 'BOUND' or delivery.get('requestId') != ident or request['candidateId'] != task.get('currentCandidateId')
            or (request.get('automatic') or {}).get('startupCheck', {}).get('status') != 'PASSED'):
        raise MigrationControlError('运行环境尚未完成交付与启动核验')
    current.update(status='COMPLETED', message='运行环境已就绪，继续原主会话', finishedAt=now())
    resume_budget(task, current)
    baseline = current.get('optimizationBaselineRunId') or (current.get('optimization') or {}).get('workingEvaluationId') or current.get('runId')
    child = {'id': 'attempt-' + str(uuid4()), 'kind': 'CHAT', 'key': 'runtime-ready-' + ident, 'requestDigest': inputs['requestDigest'],
             'baseCandidateId': task.get('currentCandidateId'), 'status': 'RUNNING', 'startedAt': now(),
             'message': 'Agent 正在处理运行环境交付', 'agentRunId': 'agent-' + str(uuid4()),
             'clarification': '用户选定的新 Runtime 已完成构建、准入与启动核验。请继续同一任务，依据实际交付验证当前工作；按原目标评测和独立审查，不把启动通过当作业务通过。'}
    if current.get('optimizationGoal'):
        for key in ('optimizationGoal', 'optimizationBudgetStartedAt', 'optimizationBudgetPausedMs'):
            if current.get(key) is not None:
                child[key] = current[key]
        child['optimizationBaselineRunId'] = baseline
    if current.get('optimization'):
        child.update(agentOptimizationOwnerId=current['id'], agentFollowup=True, agentCanReview=True)
        current['optimization']['status'] = 'RUNNING'
        current['optimization'].pop('waiting', None)
    if baseline:
        child.update(runId=baseline, runtimeChange={'baselineRunId': baseline, 'reference': delivery['id'],
            'reason': current['runtimeWait']['reason'], 'configurationDigest': inputs['configurationDigest'],
            'bindingId': delivery['id']})
        if task.get('runtimeSelectionRevision') is not None:
            child['runtimeChange']['selectionRevision'] = task['runtimeSelectionRevision']
    current.pop('runtimeWait', None)
    if inputs.get('persisted'):
        child['sessionExecutionId'] = str(uuid4())
    child['sessionInputDigest'] = inputs['inputDigest']
    if not any(item['key'] == child['key'] for item in task['attempts']):
        task['attempts'].append(child)
    return {'next': 'agent', 'attemptId': child['id']}

def _runtime_requested(task, current, inputs):
    ident = inputs['requestId']
    request = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == ident), None)
    if not inputs.get('builderAvailable') or not request or task.get('selectedRuntimeBuildRequestId') != ident:
        raise MigrationControlError('运行环境准备请求已变化')
    if request['requirements'].get('rebuild'):
        raise MigrationControlError('Builder 重建接口尚未提供；已保留工程和诊断')
    if inputs.get('conflictingRequests'):
        raise MigrationControlError('运行环境准备与评测或审查不能同时提交，请先等待运行环境就绪')
    current.update(runtimeWait={'requestId': ident, 'reason': inputs['reason']}, message='正在准备用户选定的运行环境')
    candidate = next((item for item in task['candidates'] if item['id'] == task.get('currentCandidateId')), None)
    features = inputs.get('requiredFeatures', [])
    if (request['candidateId'] != task.get('currentCandidateId') or request['candidateDigest'] != (candidate or {}).get('digest')
            or any(feature not in request['requirements']['executionRequirements']['features'] for feature in features)):
        settings = {**request['settings'], 'baseCandidateId': task.get('currentCandidateId'),
                    'runtimeType': request['requirements']['target']['runtimeType'],
                    'platform': request['requirements']['executionRequirements']['platform'],
                    'requiredCapabilities': request['requirements']['requiredCapabilities'],
                    'requiredFeatures': list(dict.fromkeys(request['requirements']['executionRequirements']['features'] + features))}
        return {'next': 'refresh', 'settings': settings}
    return {'next': 'build'}

def _runtime_wait(task, current, inputs):
    if inputs.get('error'):
        message = 'Runtime 准备未完成，工作已保留：' + inputs['error']
    else:
        message = '工作已保存，等待所选 Runtime 交付或补充 Builder 接入配置'
    current.update(status='WAITING', message=message)
    pause_budget(task, current)

def _control_ack(task, current, inputs):
    if current['status'] != 'RUNNING':
        return
    if not inputs['accepted']:
        current['sessionControl'] = {'status': 'UNKNOWN', 'updatedAt': now()}
    elif inputs['action'] == 'pause':
        current['sessionControl'] = {'status': 'PAUSED', 'updatedAt': now()}
        pause_budget(task, current)
        current['sessionInputDigest'] = inputs['inputDigest']
    else:
        resume_budget(task, current)
        current.pop('sessionControl', None)

def _reconcile_control(task, current, inputs):
    if current['status'] not in ('RUNNING', 'INTERRUPTED') or not current.get('sessionControl'):
        return
    state, paused, record = inputs['state'], inputs.get('paused') or {}, inputs.get('round') or {}
    recoverable = (inputs.get('verified') and state == 'UNAVAILABLE' and inputs.get('available') is False
                   and (paused.get('status') == 'paused' and paused.get('recoverable') or record.get('recoverable') and record.get('status') in ('running', 'finished'))
                   and current.get('sessionInputDigest') and current['sessionInputDigest'] == inputs.get('inputDigest'))
    if recoverable:
        pause_budget(task, current)
        state = 'RECOVERABLE'
    elif current['status'] == 'INTERRUPTED':
        state = 'UNKNOWN'
    elif state == 'RUNNING':
        resume_budget(task, current)
        current.pop('sessionControl', None)
        return
    elif state in ('PAUSED', 'PAUSING'):
        if state == 'PAUSED':
            pause_budget(task, current)
    else:
        state = 'UNKNOWN'
    current['sessionControl'] = {'status': state, 'updatedAt': now()}

def _register(task, inputs):
    parsed, kind, facts = inputs['input'], inputs['kind'], inputs['facts']
    digest, goal = inputs['requestDigest'], inputs.get('optimizationGoal')
    for item in task['attempts']:
        resume = next((entry for entry in item.get('resumeRequests', []) if entry['key'] == parsed['key']), None)
        if item['key'] == parsed['key'] or resume:
            if (resume['digest'] if resume else item['requestDigest']) != digest:
                raise MigrationControlError('请求标识已用于其他操作')
            return {'duplicate': True, 'attemptId': item['id']}
    if inputs.get('closing'):
        raise MigrationControlError('服务正在关闭', 503)
    if any(item['status'] == 'RUNNING' for item in task['attempts']) or inputs.get('rescoring'):
        raise MigrationControlError('任务正在执行，请等待或取消当前操作')
    if any(item.get('automatic', {}).get('status') in ('QUEUED', 'RUNNING') for item in task.get('runtimeBuildRequests', [])):
        raise MigrationControlError('Builder 构建正在执行，请等待或取消')
    if not inputs.get('runtimeManaged') and inputs.get('executing', 0) >= 2:
        raise MigrationControlError('整组任务执行资源繁忙，请稍后重试', 429)
    if parsed.get('baseCandidateId') != task.get('currentCandidateId'):
        raise MigrationControlError('候选已变化，请刷新后重试')
    if (parsed.get('additionalOptimizationRounds') or parsed.get('additionalOptimizationSeconds')) and (not parsed.get('resumeOptimizationOwnerId') or parsed.get('resumeAttemptId')):
        raise MigrationControlError('增加预算需要选择原优化任务')
    if parsed.get('resumeAttemptId'):
        current = attempt(task, parsed['resumeAttemptId'])
        if current['kind'] != kind:
            raise MigrationControlError('等待中的任务不存在')
        if parsed.get('resumePaused') or parsed.get('recoverCheckpoint'):
            if parsed.get('sessionAnswer') or current['status'] != 'INTERRUPTED' or not current.get('sessionControl') or not current.get('sessionExecutionId'):
                raise MigrationControlError('原执行不处于可恢复的暂停状态')
            if not current.get('sessionInputDigest') or current['sessionInputDigest'] != facts['inputDigest']:
                raise MigrationControlError('任务输入已变化，不能继续原执行')
            field = 'sessionResumePaused' if parsed.get('resumePaused') else 'sessionRecoverCheckpoint'
            current[field] = True
            current.pop('sessionRecoverCheckpoint' if parsed.get('resumePaused') else 'sessionResumePaused', None)
            current.update(sessionExecutionId=str(uuid4()), sessionControl={'status': 'RESUMING', 'updatedAt': now()},
                           status='RUNNING', message='正在从已保存的暂停位置继续' if parsed.get('resumePaused') else '正在从已保存的上下文和工程恢复')
        else:
            answer = parsed.get('sessionAnswer')
            if not answer or current['status'] != 'WAITING' or answer['interactionId'] not in current.get('waitingInteractionIds', []):
                raise MigrationControlError('该问题不再等待回答，请刷新后重试')
            if not answer['answers']:
                raise MigrationControlError('请填写问题的回答', 400)
            current.update(sessionAnswer=answer, sessionExecutionId=str(uuid4()), sessionInputDigest=facts['inputDigest'],
                           status='RUNNING', message='正在继续任务')
        resume_budget(task, current)
        current.pop('finishedAt', None)
        current.pop('error', None)
        current.setdefault('resumeRequests', []).append({'key': parsed['key'], 'digest': digest})
        return {'duplicate': False, 'attemptId': current['id']}
    if parsed.get('resumePaused') or parsed.get('recoverCheckpoint'):
        raise MigrationControlError('检查点恢复必须关联原执行')
    if parsed.get('sessionAnswer'):
        raise MigrationControlError('回答必须关联等待中的任务', 400)
    if any(item['status'] == 'WAITING' and item.get('waitingInteractionIds') for item in task['attempts']):
        raise MigrationControlError('任务正在等待回答，请先回答或取消')
    if any(item['kind'] == 'OPTIMIZE' and item['status'] == 'WAITING' and item.get('optimization', {}).get('waiting') for item in task['attempts']):
        raise MigrationControlError('优化正在等待外部调整，请继续或停止该优化任务')
    resumed = None
    if parsed.get('resumeOptimizationOwnerId'):
        resumed = _resume_optimization(task, parsed, kind, facts)
    selected = next((run for run in task['runs'] if run['id'] == parsed.get('runId')), None)
    if kind == 'BASELINE':
        if task.get('inputKind') != 'agent_project' or not task.get('preparations') or not task.get('baselineConfiguration') or not task.get('suite'):
            raise MigrationControlError('请先准备完整工程、保存基线运行环境与测试集')
        if parsed['phase'] != 'development':
            raise MigrationControlError('基线使用开发测试集，独立留出集保留用于验收')
    if parsed.get('prepareProject') and (kind != 'CHAT' or task.get('inputKind') != 'agent_project' or task.get('currentCandidateId')):
        raise MigrationControlError('工程运行准备仅用于尚未生成迁移候选的完整工程')
    if kind == 'CHAT' and parsed.get('runId') and not goal and (not selected or selected['phase'] != 'development' or selected['status'] == 'RUNNING'):
        raise MigrationControlError('请选择当前任务中已结束的开发集评测记录')
    if kind == 'CHAT' and goal:
        run_facts = facts['runs'].get(parsed.get('runId'), {})
        if (not selected or selected['phase'] != 'development' or selected.get('candidateId') != task.get('currentCandidateId')
                or selected.get('effectStatus', selected['status']) not in ('PASSED', 'FAILED') or not selected['cases']
                or any(case.get('failureStage') for case in selected['cases']) or not run_facts.get('repetitionsComplete')):
            raise MigrationControlError('请先对当前候选完成完整的开发集效果评测')
        pending = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == task.get('selectedRuntimeBuildRequestId')), None)
        new_builder = bool(facts['builderStatus'] == 'PENDING' and pending and pending['candidateId'] == selected['candidateId']
                           and pending['candidateDigest'] == selected['candidateDigest'] and pending['baseConfigurationDigest'] == selected['configurationDigest']
                           and not pending['requirements'].get('rebuild') and milliseconds(pending['createdAt']) >= milliseconds(selected['createdAt']))
        if (selected['configurationDigest'] != facts['configurationDigest'] or not run_facts['suiteMatches']
                or selected.get('judgeDigest') != facts.get('judgeDigest')
                or selected.get('runtimeSelectionRevision') != task.get('runtimeSelectionRevision') and not new_builder):
            raise MigrationControlError('环境、评测标准或运行条件已变化，请重新评测')
        if run_facts.get('holdoutUsed'):
            raise MigrationControlError('这份留出集已使用；继续优化前请准备新的独立留出集')
        if not new_builder and facts.get('bindingError'):
            raise MigrationControlError(facts['bindingError'])
    if kind == 'ACCEPT':
        if facts.get('runtimeInputIssues'):
            raise MigrationControlError('；'.join(facts['runtimeInputIssues']))
        if not facts['conformanceAllowed']:
            raise MigrationControlError('标准化审查仍有需要修复的问题，请先修复')
        if facts.get('bindingError'):
            raise MigrationControlError(facts['bindingError'])
        if not task.get('currentCandidateId') or not task.get('configuration') or not task.get('suite'):
            raise MigrationControlError('请先生成候选、配置环境并保存验收用例')
        if parsed['phase'] == 'holdout' and not task['suite'].get('holdoutCases'):
            raise MigrationControlError('尚未配置独立留出案例')
    current = {'id': 'attempt-' + str(uuid4()), 'kind': kind, 'key': parsed['key'], 'requestDigest': digest,
               'baseCandidateId': parsed.get('baseCandidateId'), 'status': 'RUNNING', 'startedAt': now(),
               'message': '准备整组联合验收' if kind == 'ACCEPT' else '准备完整工作区'}
    for key in ('requestId',):
        if inputs.get(key) is not None:
            current[key] = inputs[key]
    for key in ('runId', 'prepareProject', 'clarification'):
        if parsed.get(key):
            current[key] = parsed[key]
    if kind not in ('ACCEPT', 'BASELINE'):
        current['agentRunId'] = 'agent-' + str(uuid4())
    if kind == 'CHAT' and inputs.get('persisted'):
        current.update(sessionExecutionId=str(uuid4()), sessionInputDigest=facts['inputDigest'])
    if kind == 'CHAT' and goal:
        current.update(optimizationGoal=goal, optimizationBaselineRunId=parsed.get('runId'))
        if goal.get('maxDurationSeconds'):
            current['optimizationBudgetStartedAt'] = now()
    elif kind == 'CHAT' and parsed.get('runId'):
        current['discussionEvidenceRunId'] = parsed['runId']
    if resumed:
        current.update(agentFollowup=True, agentCanReview=True, agentOptimizationOwnerId=resumed['id'])
        if resumed.get('runtimeChange'):
            current['runtimeChange'] = resumed['runtimeChange']
        if resumed['optimization']['stage'] == 'EVALUATION':
            current['agentResumeEvaluation'] = True
        if parsed.get('additionalOptimizationRounds') or parsed.get('additionalOptimizationSeconds'):
            extra = (f" {parsed['additionalOptimizationRounds']} 轮" if parsed.get('additionalOptimizationRounds') else '') + (f" {parsed['additionalOptimizationSeconds']} 秒" if parsed.get('additionalOptimizationSeconds') else '')
            current['clarification'] = f"用户增加了{extra}，继续原优化；总预算为 {resumed['optimization']['goal']['maxRounds']} 轮，当前阶段为 {resumed['optimization']['stage']}，保留已完成轮次、目标和证据。若评测中断可重跑本轮；若审查中断只重试审查。达到目标或预算后停止。"
        else:
            current['clarification'] = f"用户选择继续原优化。当前阶段为 {resumed['optimization']['stage']}；复用原目标、轮次和证据。若评测中断，用户已明确允许重跑本轮；若审查中断，只重试审查。"
    task['attempts'].append(current)
    return {'duplicate': False, 'attemptId': current['id']}
