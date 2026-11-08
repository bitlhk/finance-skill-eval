"""Read-only migration task projection consumed by the existing UI."""
from copy import deepcopy
from tasks.values import fingerprint
from .facts import current_candidate, builder_status, run_configuration_current, run_suite_matches, completed_repetitions, scope_digest, development_current
from .integrity import approved_plan, candidate_plan_current, basic_report, basic_current, verify_delivery


def baseline_for(task, preparation, judge_digest):
    if not task.get('baselineConfiguration') or not task.get('suite'):
        return None
    return next((run for run in reversed(task['runs']) if run.get('purpose') == 'baseline'
        and run['candidateId'] == preparation['id'] and run['candidateDigest'] == preparation['digest']
        and run['configurationDigest'] == fingerprint(task['baselineConfiguration']) and run_suite_matches(task['suite'], run)
        and run.get('judgeDigest') == judge_digest), None)


def current_baseline(task, judge_digest):
    preparation = (task.get('preparations') or [None])[-1]
    run = baseline_for(task, preparation, judge_digest) if preparation else None
    return run if run and completed_repetitions(task, run) else None


def project_comparison(task, judge_digest):
    if task.get('inputKind') != 'agent_project' or not task.get('suite') or not task.get('configuration') or not candidate_plan_current(task):
        return None
    baseline = current_baseline(task, judge_digest)
    if not baseline:
        return None
    candidate = next((run for run in reversed(task['runs']) if run.get('purpose') != 'baseline' and run['phase'] == 'development'
        and run['candidateId'] == task['currentCandidateId'] and run['candidateDigest'] == (current_candidate(task) or {}).get('digest')
        and run_suite_matches(baseline['suite'], run) and run_configuration_current(task, run, judge_digest)), None)
    left = completed_repetitions(task, baseline, 'effect')
    right = completed_repetitions(task, candidate, 'effect') if candidate else None
    if not left or not right:
        return None
    cases = []
    for case in task['suite']['cases']:
        row = {'id': case['id']}
        for name, runs in (('baseline', left), ('candidate', right)):
            results = [next((item for item in run['cases'] if item['id'] == case['id']), None) for run in runs]
            if any(not item or item.get('failureStage') or item.get('unverified') for item in results):
                return None
            row[name] = {'passed': sum(item['passed'] for item in results), 'total': len(results)}
        cases.append(row)
    return {'method': 'INDEPENDENT_CASE_VERDICTS', 'baselineRunId': baseline['id'], 'candidateRunId': candidate['id'], 'cases': cases}


def execution_statistics(task, run):
    group = run['repetition']
    attempts = [next((item['cases'] for item in task['runs'] if item.get('repetition', {}).get('groupId') == group['groupId']
        and item['repetition']['index'] == index), []) for index in range(1, group['total'] + 1)]
    total, result = group['total'], []
    for case in run['suite'].get('holdoutCases', []) if run['phase'] == 'holdout' else run['suite']['cases']:
        values = [next((item for item in cases if item['id'] == case['id']), None) for cases in attempts]
        observed = [item for item in values if item and not item.get('failureStage') and not item.get('unverified')]
        passed = sum(item['passed'] for item in observed)
        failed = len(observed) - passed
        result.append({'caseId': case['id'], 'total': total, 'passed': passed, 'failed': failed, 'unverified': total - len(observed),
            'coverage': len(observed) / total, 'successRate': passed / total, 'allPassed': passed == total, 'variableOutcomes': passed > 0 and failed > 0})
    return result


async def task_view(service, original):
    task = deepcopy(original)
    judge_digest = service.judge_identity()
    status, candidate = builder_status(task), current_candidate(task)
    check, runtime_review = task.get('startupCheck'), task.get('runtimeReview')
    configuration_digest = fingerprint(task.get('configuration'))
    plan_digest = fingerprint(task['analysis']) if task.get('analysis') else None
    binding_id = task.get('runtimeDelivery', {}).get('id') if task.get('selectedRuntimeBuildRequestId') else None
    plan_current = candidate_plan_current(task)
    task.update(currentJudgeDigest=judge_digest, builderStatus=status, planApproved=approved_plan(task), candidatePlanCurrent=plan_current,
        startupCheckCurrent=bool(plan_current and check and task.get('configuration') and check['candidateId'] == task['currentCandidateId']
            and check['configurationDigest'] == configuration_digest and check.get('runtimeSelectionRevision') == task.get('runtimeSelectionRevision')
            and check.get('builderBindingId') == binding_id and status not in ('PENDING', 'STALE')),
        runtimeReviewCurrent=bool(runtime_review and task.get('configuration') and plan_current and runtime_review['candidateId'] == task['currentCandidateId']
            and runtime_review['configurationDigest'] == configuration_digest and runtime_review.get('planDigest') == plan_digest
            and runtime_review.get('runtimeSelectionRevision') == task.get('runtimeSelectionRevision')))
    if plan_digest:
        task['currentPlanDigest'] = plan_digest
    if candidate and any(review['candidateId'] == candidate['id'] and review.get('basicReview') for review in task.get('deliveryReviews', [])):
        try:
            frozen = await service.repository.read_snapshot(task['id'], candidate['id'])
            basic = basic_report(task, candidate, frozen, judge_digest)
            if basic['approved'] and basic.get('review', {}).get('basicReview'):
                task['basicDelivery'] = {'reviewId': basic['review']['id'], 'scope': basic['review']['basicReview']['scope'],
                    'coversTaskScope': basic['review']['basicReview'].get('coversTaskScope') is True}
            verified = verify_delivery(task, frozen, judge_digest, basic)
            if verified:
                task['verifiedRunId'] = verified['run']['id']
                task['deliveryVerification'] = {'basicScope': verified['basic']['scope'], 'effectGoal': verified['effect']['goal'], 'rates': verified['rates']}
        except (ValueError, OSError, KeyError):
            pass  # Missing/corrupt saved evidence never grants delivery approval.
    for run in task['runs']:
        run['hasCandidateFailures'] = (any(any(criterion['passed'] is False for criterion in case.get('criteria', []))
            or not case['passed'] and not case.get('unverified') for case in run['cases']) or any(item['status'] == 'FAILED' for item in run.get('requirementCoverage', [])))
        run['configurationCurrent'] = run_configuration_current(task, run, judge_digest)
        run['requirementCoverageCurrent'] = bool(plan_current and run['configurationCurrent'] and fingerprint(run.get('assessmentRequirements', []))
            == fingerprint(((task.get('analysis') or {}).get('standardization') or {}).get('requirements', [])))
        if run.get('repetition'):
            run['executionStatistics'] = execution_statistics(task, run)
    for review in task.get('deliveryReviews', []):
        review.update(scopeCurrent=review.get('scopeDigest') == scope_digest(task), basicEvidenceCurrent=basic_current(task, review, judge_digest))
    for review in task.get('effectReviews', []):
        run = next((item for item in task['runs'] if item['id'] == review['candidateRunId']), None)
        review.update(scopeCurrent=review.get('scopeDigest') == scope_digest(task),
            configurationCurrent=bool(run and run['candidateDigest'] == review['candidateDigest'] and development_current(task, run, judge_digest)))
    for preparation in task.get('preparations', []):
        preparation['baselineStatus'] = (baseline_for(task, preparation, judge_digest) or {}).get('status', 'NOT_EVALUATED')
    baseline = current_baseline(task, judge_digest)
    if baseline:
        task['currentBaselineRunId'] = baseline['id']
    compared = project_comparison(task, judge_digest)
    if compared:
        task['projectComparison'] = compared
    return task
