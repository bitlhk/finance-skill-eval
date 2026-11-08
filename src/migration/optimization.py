"""Migration evaluation/Review continuation and optimization budget control."""
from copy import deepcopy
from datetime import datetime, timezone
from uuid import uuid4

from .state import MigrationControlError, now, milliseconds, remaining, expired, attempt, owner, pause_budget, resume_budget, followup, finish, _runtime_changed, _recoverable

def _evaluation_requested(task, current, inputs):
    root = owner(task, current)
    loop = inputs.get('startingOptimization') or root.get('optimization') if inputs.get('optimizationOwnerId') else None
    if inputs.get('evaluationIssues'):
        raise MigrationControlError('开发集评测条件未就绪')
    if loop and expired(loop.get('deadlineAt')):
        if inputs.get('startingOptimization'):
            root['optimization'] = loop
            root['optimizationInputs'] = inputs['optimizationInputs']
        loop.update(status='REVIEW', reason='达到时间预算，保留当前工作与审查结果', finishedAt=now())
        finish(current, '达到时间预算，工作已保留')
        return {'next': 'done'}
    retry = bool(loop and current.get('agentResumeEvaluation') and loop['stage'] == 'EVALUATION'
                 and loop['rounds'] and loop['rounds'][-1]['stage'] == 'EVALUATION'
                 and loop['rounds'][-1].get('candidate', {}).get('digest') == inputs['candidateDigest'])
    if loop and (loop['status'] != 'RUNNING' or not retry and (loop['stage'] != 'ADJUSTMENT' or len(loop['rounds']) >= loop['goal']['maxRounds'])):
        raise MigrationControlError('优化预算已用完或本轮尚未完成审查')
    if loop and not retry and inputs['candidateDigest'] == loop.get('working', loop['baseline'])['digest'] and not inputs.get('runtimeChanged'):
        raise MigrationControlError('工作文件与运行环境尚无变化，请先诊断并调整')
    if not task.get('configuration') or not task.get('suite') or not task.get('currentCandidateId'):
        raise MigrationControlError('请先配置 Runtime 和开发测试集')
    if inputs.get('bindingError'):
        raise MigrationControlError(inputs['bindingError'])
    if inputs.get('runtimeInputIssues'):
        raise MigrationControlError('；'.join(inputs['runtimeInputIssues']))
    current.update(agentEvaluation='RUNNING', message='正在运行开发集评测')
    if loop:
        if inputs.get('startingOptimization'):
            root['optimization'] = loop
            root['optimizationInputs'] = inputs['optimizationInputs']
        loop['stage'] = 'EVALUATION'
        if not retry:
            loop['rounds'].append({'number': len(loop['rounds']) + 1, 'baseline': deepcopy(loop.get('working', loop['baseline'])),
                                   'stage': 'EVALUATION', 'candidate': {'id': task['currentCandidateId'], 'digest': inputs['candidateDigest']}})
    return {'next': 'evaluate', 'optimizationOwnerId': root['id'] if loop else None}

def _agent_context(task, current, inputs):
    root = owner(task, current)
    loop = root.get('optimization') if current.get('agentOptimizationOwnerId') else None
    if current.get('agentOptimizationOwnerId') and not loop:
        raise MigrationControlError('优化状态不存在，不能继续本轮')
    if loop and loop['status'] == 'RUNNING' and expired(loop.get('deadlineAt')):
        loop.update(status='REVIEW', reason='达到时间预算，保留当前工作与审查结果', finishedAt=now())
    continuation = next((item for item in reversed(task['attempts']) if item['kind'] == 'CHAT' and
                         item.get('optimization', {}).get('status') in ('REVIEW', 'INTERRUPTED')), None)
    result = {'activeOptimization': loop}
    if continuation and current['kind'] == 'CHAT' and not current.get('agentFollowup') and not current.get('optimizationGoal'):
        result.update(continuationOwner=continuation, budgetContinuation={
            'ownerAttemptId': continuation['id'], 'status': continuation['optimization']['status'],
            'goal': continuation['optimization']['goal'], 'usedRounds': len(continuation['optimization']['rounds'])})
    if loop:
        state = {'goal': loop['goal'], 'remainingRounds': max(0, loop['goal']['maxRounds'] - len(loop['rounds'])) if not expired(loop.get('deadlineAt')) else 0,
                 'workingRunId': loop.get('workingEvaluationId', loop.get('baselineEvaluationId')),
                 'workingDigest': loop.get('working', loop['baseline'])['digest'], 'bestRunId': loop['bestEvaluationId'],
                 'phase': loop['stage'] if loop['stage'] in ('ADJUSTMENT', 'REVIEW') else 'EVALUATION', 'status': loop['status']}
        if _runtime_changed(task, current.get('runtimeChange'), inputs):
            state['runtimeChanged'] = True
        if current.get('agentResumeEvaluation'):
            state['resumePendingEvaluation'] = True
            if loop['rounds'] and loop['rounds'][-1].get('candidate'):
                state['pendingCandidateDigest'] = loop['rounds'][-1]['candidate']['digest']
        result['agentOptimization'] = state
    return result

def _optimization_start(task, current, inputs):
    request = inputs.get('optimizationRequest')
    if not request and not (current.get('optimizationGoal') and inputs.get('evaluationRequested')):
        return None
    if not inputs.get('evaluationRequested') or inputs.get('activeOptimization') or not inputs.get('reviewAvailable'):
        raise MigrationControlError('无法开始该优化任务，请先确认评测与独立审查条件')
    goal = current.get('optimizationGoal') or request['goal']
    ident = current.get('optimizationBaselineRunId') if current.get('optimizationGoal') else request['baselineRunId']
    baseline = next((item for item in task['runs'] if item['id'] == ident), None)
    facts = inputs['facts']
    changed = _runtime_changed(task, current.get('runtimeChange'), facts) and current['runtimeChange'].get('baselineRunId') == ident
    observed = facts['runs'].get(ident, {})
    if (not baseline or baseline['phase'] != 'development' or not changed and
            (baseline['candidateId'] != task.get('currentCandidateId') or baseline['candidateDigest'] != inputs['baseDigest'])
            or not observed.get('repetitionsComplete')):
        raise MigrationControlError('请先对当前文件完成开发集基线评测')
    if (not changed and (baseline['configurationDigest'] != facts['configurationDigest'] or
                        baseline.get('runtimeSelectionRevision') != task.get('runtimeSelectionRevision'))
            or not observed['suiteMatches'] or baseline.get('judgeDigest') != facts.get('judgeDigest')):
        raise MigrationControlError('评测条件已变化，请先重新建立基线')
    if observed.get('holdoutUsed'):
        raise MigrationControlError('留出集已使用，请准备新的独立留出集后再优化')
    evaluated = inputs.get('baselineEvaluation')
    from improvement.policy import comparable
    if not evaluated or not comparable(evaluated, evaluated):
        raise MigrationControlError('开发集基线尚未完整完成')
    if any(ident not in {case['id'] for case in evaluated['cases']} for ident in goal.get('protectedCaseIds', [])):
        raise MigrationControlError('必须通过的案例不属于开发集')
    started = milliseconds(current['optimizationBudgetStartedAt']) + current.get('optimizationBudgetPausedMs', 0) if current.get('optimizationBudgetStartedAt') else milliseconds(now())
    created = current.get('optimizationBudgetStartedAt') or now()
    result = {'id': 'loop-' + str(uuid4()), 'goal': goal, 'baseline': evaluated['candidate'], 'best': evaluated['candidate'],
              'baselineEvaluationId': baseline['id'], 'bestEvaluationId': baseline['id'],
              'working': evaluated['candidate'], 'workingEvaluationId': baseline['id'],
              'status': 'RUNNING', 'stage': 'ADJUSTMENT', 'rounds': [], 'createdAt': created}
    if goal.get('maxDurationSeconds') is not None:
        result['deadlineAt'] = datetime.fromtimestamp((started + goal['maxDurationSeconds'] * 1000) / 1000,
                                                      timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    return result

def _evaluation_completed(task, current, inputs):
    root_id = inputs.get('optimizationOwnerId')
    if root_id:
        root = attempt(task, root_id)
        loop = root['optimization']
        change = inputs.get('contextChange')
        if change and change not in loop.get('contextChanges', []):
            loop.setdefault('contextChanges', []).append(change)
        round_ = loop['rounds'][-1]
        round_['evaluationId'] = inputs['run']['id']
        if inputs['run'].get('effectStatus', inputs['run']['status']) not in ('PASSED', 'FAILED') or not inputs.get('repetitionsComplete'):
            loop.update(status='INTERRUPTED', reason='本轮评测未完成，保留工作与证据，未结算优化轮次')
            value = remaining(loop.get('deadlineAt'))
            if value is not None:
                root['agentOptimizationRemainingMs'] = value
        else:
            loop['stage'] = round_['stage'] = 'REVIEW'
    run = inputs['run']
    text = (f"开发集评测 {run['id']} 已结束，效果状态为 {run.get('effectStatus', run['status'])}，基础要求覆盖状态为 {run['status']}。请查询该记录并分别解释结果。" +
            ('本轮处于审查阶段，请按既定目标请求独立效果审查。' if root_id else
             '遵守用户原先的要求；如果只要求评测或建立基线，不要自行修改文件或启动优化，说明结果后直接结束，不必询问后续步骤。') +
            '不要声称未经审查的结果已验收。')
    child = followup(task, text, 'Agent 正在分析评测结果', optimization_owner=root_id, can_review=True,
                     persisted=inputs.get('persisted'), input_digest=inputs.get('inputDigest'))
    current['agentEvaluation'] = 'FINISHED'
    finish(current, '开发集评测已结束，正在继续分析')
    task['attempts'].append(child)
    return {'next': 'agent', 'attemptId': child['id']}

def _review_completed(task, current, inputs):
    evaluated, review = inputs['evaluated'], inputs['review']
    root_id = current.get('agentOptimizationOwnerId')
    loop = owner(task, current).get('optimization') if root_id else None
    from improvement.policy import select
    from improvement.policy import select_goal
    goal_only = inputs.get('baseline') is None
    if goal_only and loop:
        raise MigrationControlError('持续优化必须使用真实基线进行效果对比')
    decision = select_goal(evaluated, review) if goal_only else select(inputs['baseline'], evaluated, inputs['incumbent'], review,
                      loop['goal'].get('protectedCaseIds', []) if loop else [], loop.get('contextChanges', []) if loop else [])
    saved = {'id': 'effect-review-' + str(uuid4()), 'candidateRunId': evaluated['id'],
             'scopeDigest': inputs['scopeDigest'],
             'protectedCaseIds': loop['goal'].get('protectedCaseIds', []) if loop else [],
             'candidateDigest': evaluated['candidate']['digest'], 'goal': loop['goal']['goal'] if loop else task['goal'],
             'createdAt': now(), 'review': review, 'decision': decision}
    if goal_only:
        saved['assessmentMode'] = 'GOAL'
    else:
        saved.update(baselineRunId=inputs['baseline']['id'], incumbentRunId=inputs['incumbent']['id'])
    if loop:
        saved.update(optimizationOwnerAttemptId=root_id, targetPassRate=loop['goal']['targetPassRate'], contextChanges=loop.get('contextChanges', []))
    task.setdefault('effectReviews', []).append(saved)
    if root_id:
        root = attempt(task, root_id)
        loop = root['optimization']
        round_ = loop['rounds'][-1]
        round_['review'] = review
        passed = {case['id'] for case in evaluated['cases'] if case.get('passed') is True}
        protected_failed = any(ident not in passed for ident in loop['goal'].get('protectedCaseIds', []))
        evidence = inputs['evidence']
        references = review.get('review', {}).get('evidenceIds', []) if review['status'] == 'PRODUCED' else []
        references_valid = bool(references) and len(set(references)) == len(references) and set(references).issubset({item['evidenceId'] for item in evidence})
        complete = (bool(evidence) and all(item['completed'] and item['comparable'] for item in evidence)
                    and references_valid and review['status'] == 'PRODUCED' and review['review']['recommendation'] != 'INCONCLUSIVE'
                    and (decision['selected'] or decision['continued'] or review['review']['recommendation'] == 'KEEP_BASELINE' or protected_failed))
        round_.update(stage='SELECTION' if complete else 'REVIEW', **decision)
        if decision['selected']:
            loop.update(best=evaluated['candidate'], bestEvaluationId=evaluated['id'])
        if decision['selected'] or decision['continued']:
            loop.update(working=evaluated['candidate'], workingEvaluationId=evaluated['id'])
        loop['targetReached'] = bool(decision['selected'] and evaluated['cases'] and len(passed) / len(evaluated['cases']) >= loop['goal']['targetPassRate'])
        if not complete:
            loop.update(status='INTERRUPTED', reason=review['reason'] if review['status'] == 'ABSTAINED' else decision['reason'])
        elif not decision['selected'] and not decision['continued']:
            loop.update(status='REVIEW', reason=decision['reason'], finishedAt=now())
        elif loop['targetReached'] or len(loop['rounds']) >= loop['goal']['maxRounds'] or expired(loop.get('deadlineAt')):
            loop.update(status='REVIEW', reason='达到目标并完成独立审查' if loop['targetReached'] else '已达到优化预算，保留审查结果和工作文件', finishedAt=now())
        else:
            loop['stage'] = 'ADJUSTMENT'
        if loop['status'] in ('INTERRUPTED', 'REVIEW'):
            value = remaining(loop.get('deadlineAt'))
            if value is not None:
                root['agentOptimizationRemainingMs'] = value
    continuation = ('请查询审查和优化状态，依据用户设定的目标及剩余轮次决定是否继续修复；预算用完或目标达成时停止，并区分未完成的验证。' if loop else
        '请查询审查结果，继续完成用户原任务中尚未完成的基础验证、交付审查和工作产物。效果审查通过不等于完整交付通过；都已满足时总结结果，不自行启动持续优化或扩大范围。')
    child = followup(task,
        f"独立效果审查 {saved['id']} 已完成。决定：{decision['reason']}。" + continuation,
        'Agent 正在解释独立审查结果', optimization_owner=root_id,
        can_review=not bool(loop),
        persisted=inputs.get('persisted'), input_digest=inputs.get('inputDigest'))
    current['agentReview'] = 'FINISHED'
    finish(current, '独立效果审查已结束，正在继续分析')
    task['attempts'].append(child)
    return {'next': 'agent', 'attemptId': child['id']}

def _review_requested(task, current, inputs):
    if current.get('agentFollowup') and not current.get('agentCanReview'):
        raise MigrationControlError('当前回合不能再次请求独立审查')
    request = inputs['request']
    before = next((run for run in task['runs'] if run['id'] == request.get('baselineRunId')), None)
    after = next((run for run in task['runs'] if run['id'] == request['candidateRunId']), None)
    candidate = next((item for item in task['candidates'] if item['id'] == task.get('currentCandidateId')), None)
    if (not after or after['phase'] != 'development' or 'baselineRunId' in request and (not before or before['id'] == after['id'] or before['phase'] != 'development')
            or not candidate or after['candidateId'] != candidate['id'] or after['candidateDigest'] != candidate['digest']):
        raise MigrationControlError('独立审查需要当前文件和对应的开发集评测，请先完成并核对版本')
    loop = owner(task, current).get('optimization') if current.get('agentOptimizationOwnerId') else None
    if loop and (not before or loop['status'] != 'RUNNING' or loop['stage'] != 'REVIEW' or before['id'] != loop.get('workingEvaluationId')
                 or after['id'] != loop['rounds'][-1].get('evaluationId')):
        raise MigrationControlError('审查记录不属于当前优化轮次')
    incumbent = next((run for run in task['runs'] if run['id'] == loop['bestEvaluationId']), None) if loop else before
    if before and not incumbent:
        raise MigrationControlError('缺少优化推荐基线')
    current.update(agentReview='RUNNING', message='正在进行独立效果审查')
    return {**({'baselineRunId': before['id'], 'incumbentRunId': incumbent['id']} if before else {'assessmentMode': 'GOAL'}),
            'candidateRunId': after['id'],
            'activeOptimization': loop, 'goal': loop['goal']['goal'] if loop else task['goal'],
            'remainingRounds': max(0, loop['goal']['maxRounds'] - len(loop['rounds'])) if loop else None}

def _resume_optimization(task, parsed, kind, facts):
    if kind != 'CHAT' or 'optimization' in parsed or parsed.get('clarification') or parsed.get('autoRetest'):
        raise MigrationControlError('不能在恢复时修改优化目标或预算')
    root = attempt(task, parsed['resumeOptimizationOwnerId'])
    loop, frozen = root.get('optimization'), root.get('optimizationInputs')
    extending = 'additionalOptimizationRounds' in parsed or 'additionalOptimizationSeconds' in parsed
    last = loop['rounds'][-1] if loop and loop['rounds'] else {}
    finished = bool(loop and loop['status'] == 'REVIEW')
    pending = bool(finished and loop['stage'] == 'ADJUSTMENT')
    if (root['kind'] != 'CHAT' or not loop or not frozen or not extending and loop['status'] != 'INTERRUPTED'
            or extending and loop['status'] != 'INTERRUPTED' and (not finished or loop.get('targetReached') or not pending and last.get('stage') != 'SELECTION')):
        raise MigrationControlError('没有可继续的优化；增加预算需要中断的任务或已完成审查且尚未达成目标的任务')
    if not facts['frozenSuites'].get(root['id']) or frozen['planDigest'] != facts['planDigest'] or frozen.get('judgeDigest') != facts.get('judgeDigest'):
        raise MigrationControlError('评测方案或评判器已变化，不能继续原优化')
    baseline = next((run for run in task['runs'] if run['id'] == loop.get('workingEvaluationId')), None)
    changed = _runtime_changed(task, root.get('runtimeChange'), facts)
    if not baseline or not changed and (baseline['configurationDigest'] != facts['configurationDigest']
            or baseline.get('runtimeSelectionRevision') != task.get('runtimeSelectionRevision')
            or baseline.get('builderBindingId') != ((task.get('runtimeDelivery') or {}).get('id') if task.get('selectedRuntimeBuildRequestId') else None)):
        raise MigrationControlError('Runtime 或配置已变化，不能继续原优化')
    if any(run['phase'] == 'holdout' and facts['runs'][run['id']]['suiteMatches'] for run in task['runs']):
        raise MigrationControlError('留出集已使用，不能继续原优化')
    if facts.get('bindingError'):
        raise MigrationControlError(facts['bindingError'])
    saved = any((item['id'] == root['id'] or item.get('agentOptimizationOwnerId') == root['id']) and item['status'] == 'COMPLETED'
                and item.get('resultCandidateId') == task.get('currentCandidateId') for item in task['attempts'])
    if pending and not saved and task.get('currentCandidateId') != loop.get('working', {}).get('id'):
        raise MigrationControlError('当前文件与预算暂停时的工作版本不同，请先确认工作版本')
    if finished and not pending and (not loop.get('working') or loop['working']['id'] != task.get('currentCandidateId')):
        raise MigrationControlError('当前文件与可继续优化的版本不同，请先确认工作版本')
    if not finished and loop['stage'] in ('EVALUATION', 'REVIEW') and last.get('candidate', {}).get('id') != task.get('currentCandidateId'):
        raise MigrationControlError('工作文件已变化，不能继续原轮次')
    if not finished and loop['stage'] == 'REVIEW' and not any(run['id'] == last.get('evaluationId') and run['phase'] == 'development' and run['status'] in ('PASSED', 'FAILED') for run in task['runs']):
        raise MigrationControlError('缺少本轮完整评测，不能恢复审查')
    budget = root.get('agentOptimizationRemainingMs', remaining(loop.get('deadlineAt')))
    previous_duration = loop['goal'].get('maxDurationSeconds')
    if 'additionalOptimizationSeconds' in parsed:
        if previous_duration is None or budget is None:
            raise MigrationControlError('原优化没有设置总时间预算，无需增加时间')
        if previous_duration + parsed['additionalOptimizationSeconds'] > 7200:
            raise MigrationControlError('总时间预算不能超过 7200 秒')
        budget += parsed['additionalOptimizationSeconds'] * 1000
    if budget is not None and budget <= 0:
        raise MigrationControlError('优化时间预算已用完')
    if extending:
        old = loop['goal']['maxRounds']
        new = old + parsed.get('additionalOptimizationRounds', 0)
        if new > 9007199254740991:
            raise MigrationControlError('优化轮次超过允许范围')
        if finished and new <= len(loop['rounds']):
            raise MigrationControlError('已用完轮次，请同时增加优化轮次')
        change = {'at': now(), 'previousMaxRounds': old, 'maxRounds': new}
        loop['goal']['maxRounds'] = new
        if previous_duration is not None:
            loop['goal']['maxDurationSeconds'] = previous_duration + parsed.get('additionalOptimizationSeconds', 0)
        if parsed.get('additionalOptimizationSeconds'):
            change.update(previousMaxDurationSeconds=previous_duration, maxDurationSeconds=loop['goal']['maxDurationSeconds'])
        loop.setdefault('budgetChanges', []).append(change)
        if finished:
            loop['stage'] = 'ADJUSTMENT'
    loop['status'] = 'RUNNING'
    if budget is None:
        loop.pop('deadlineAt', None)
    else:
        loop['deadlineAt'] = datetime.fromtimestamp((milliseconds(now()) + budget) / 1000, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    loop.pop('reason', None)
    loop.pop('finishedAt', None)
    root.pop('agentOptimizationRemainingMs', None)
    return root


def _select_recommended(task, current, inputs):
    loop = current.get('optimization')
    if (not loop or loop['status'] not in ('REVIEW', 'STOPPED') or task.get('currentCandidateId') not in
            [loop['baseline']['id'], loop.get('working', {}).get('id'), loop['best']['id'],
             *(item.get('candidate', {}).get('id') for item in loop['rounds'])]):
        raise MigrationControlError('没有可选择的推荐版本，或工作版本已经变化')
    run = next((item for item in task['runs'] if item['id'] == loop['bestEvaluationId']), None)
    candidate = next((item for item in task['candidates'] if item['id'] == loop['best']['id']), None)
    facts = inputs['facts']
    if (not run or run['configurationDigest'] != facts['configurationDigest'] or not facts['runs'][run['id']]['suiteMatches']
            or run.get('judgeDigest') != facts.get('judgeDigest') or run.get('runtimeSelectionRevision') != task.get('runtimeSelectionRevision')
            or (candidate or {}).get('planRevisionId') != task.get('planRevisionId')):
        raise MigrationControlError('评测条件已变化，请重新验证候选')
    task['currentCandidateId'] = loop['best']['id']


def _assert_optimization_inputs(task, current, inputs):
    frozen, loop, facts = current.get('optimizationInputs'), current.get('optimization'), inputs['facts']
    if not frozen or not loop or task.get('currentCandidateId') != loop['baseline']['id']:
        raise MigrationControlError('优化基线已变化，请保留历史后重新发起')
    if not facts['frozenSuites'].get(current['id']) or frozen['planDigest'] != facts['planDigest']:
        raise MigrationControlError('优化目标、方案或测试集已变化，不能继续原任务')


def _external_resume(task, current, inputs):
    """Bring persisted external-adjustment waits into the same main Agent."""
    _assert_optimization_inputs(task, current, inputs)
    loop, facts = current['optimization'], inputs['facts']
    waiting = loop.get('waiting')
    if current['status'] != 'WAITING' or loop['status'] != 'WAITING' or not waiting:
        raise MigrationControlError('此优化任务不处于等待状态')
    if current['optimizationInputs'].get('judgeDigest') != facts.get('judgeDigest'):
        raise MigrationControlError('评估器已变化，不能继续原优化任务')
    if waiting['kind'] == 'INPUT':
        raise MigrationControlError('该诊断需要重新确认评测方案，请先停止本任务后调整方案')
    previous = next((run for run in task['runs'] if run['id'] == loop.get('workingEvaluationId')), None)
    if not previous or not task.get('configuration'):
        raise MigrationControlError('缺少恢复优化所需的运行配置或基线')
    if waiting['kind'] == 'BUILDER':
        if facts.get('bindingError'):
            raise MigrationControlError(facts['bindingError'])
        request = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == waiting.get('requestId')), None)
        delivery = task.get('runtimeDelivery') or {}
        if (not request or request.get('optimizationAttemptId') != current['id'] or request['candidateId'] != waiting['candidate']['id']
                or task.get('selectedRuntimeBuildRequestId') != request['requirements']['requestId']
                or delivery.get('requestId') != request['requirements']['requestId']):
            raise MigrationControlError('请先接收与本轮实验版本匹配的 Builder 交付')
        if delivery.get('id') == previous.get('builderBindingId'):
            raise MigrationControlError('需要新的 Builder 交付')
    elif facts['configurationDigest'] == previous['configurationDigest']:
        raise MigrationControlError('运行配置尚未调整')
    if any(run.get('phase') == 'holdout' and facts['runs'][run['id']]['suiteMatches'] for run in task['runs']):
        raise MigrationControlError('留出集已消费，不能继续优化')
    if not loop['rounds']:
        raise MigrationControlError('等待记录缺少原优化轮次')
    if waiting.get('remainingMs') is not None:
        loop['deadlineAt'] = datetime.fromtimestamp((milliseconds(now()) + waiting['remainingMs']) / 1000,
                                                  timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
    else:
        loop.pop('deadlineAt', None)
    for key in ('finishedAt', 'reason', 'waiting'):
        loop.pop(key, None)
    for key in ('finishedAt', 'error'):
        current.pop(key, None)
    current.update(kind='CHAT', status='COMPLETED', message='外部调整已就绪，继续本轮复测与审查')
    loop.update(status='INTERRUPTED', stage='EVALUATION')
    loop['rounds'][-1].update(stage='EVALUATION', candidate=deepcopy(waiting['candidate']))
    current['runtimeChange'] = {'baselineRunId': loop.get('workingEvaluationId', loop.get('baselineEvaluationId')),
        'reference': waiting.get('requestId') or 'configuration:' + facts['configurationDigest'],
        'reason': waiting['reason'], 'configurationDigest': facts['configurationDigest']}
    if task.get('runtimeSelectionRevision') is not None:
        current['runtimeChange']['selectionRevision'] = task['runtimeSelectionRevision']
    if task.get('runtimeDelivery'):
        current['runtimeChange']['bindingId'] = task['runtimeDelivery']['id']
    task['currentCandidateId'] = waiting['candidate']['id']
