"""Revalidate saved basic/effect review advice before display or delivery."""
import base64
from copy import deepcopy

from api.contracts import parse
from improvement.basic_review import execute as validate_basic
from improvement.policy import comparable, select
from improvement.delivery import execute as delivery_decision
from tasks.values import fingerprint
from .facts import current_candidate, scope_digest, development_current, completed_repetitions, builder_status, run_suite_matches
from .evaluation_view import optimization_evaluation


def valid_delivery_review(value, files, digest):
    try:
        review = parse('delivery_review', value)
        if review['workspaceDigest'] != digest or review['decision'] == 'RECOMMEND' and not review['citations']:
            return None
        for citation in review['citations']:
            if not citation['path'].startswith('candidate/') or not citation['quote'].strip():
                return None
            name = citation['path'][len('candidate/'):]
            text = base64.b64decode(files[name], validate=True).decode('utf-8').replace('\r\n', '\n').replace('\r', '\n')
            if citation['quote'].replace('\r\n', '\n').replace('\r', '\n') not in text:
                return None
        return review
    except (KeyError, ValueError, UnicodeError):
        return None


def basic_current(task, review, judge_digest):
    return bool(review.get('basicReview')) and all(ref['kind'] != 'development_run' or any(run['id'] == ref['id']
        and run['candidateDigest'] == review['workspaceDigest'] and development_current(task, run, judge_digest) for run in task['runs'])
        for ref in review['basicReview']['references'])


def execution_receipts(task):
    values = [receipt for item in task.get('preparations', []) + task['candidates'] + task['attempts'] for receipt in item.get('executions', [])]
    return [{**receipt, 'receiptId': receipt.get('receiptId') or 'project-check-' + fingerprint(receipt)[:32]} for receipt in values]


def basic_report(task, candidate, bundle, judge_digest):
    review = next((item for item in reversed(task.get('deliveryReviews', [])) if item['candidateId'] == candidate['id'] and item['workspaceDigest'] == candidate['digest']), None)
    if not review or not review.get('basicReview'):
        return {'approved': False, 'review': None, 'report': {'status': 'NOT_ASSESSED',
            'note': '最近一次交付审查未包含基础验证结论。' if review else '没有针对当前文件的基础验证审查。'}}
    checks = execution_receipts(task)
    runs = [{'runId': run['id'], 'phase': run['phase'], 'status': run['status'], 'candidateDigest': run['candidateDigest'],
        'matchesCurrentConfiguration': development_current(task, run, judge_digest)} for run in task['runs'] if run['phase'] == 'development']
    validation = validate_basic({'review': review['basicReview'], 'digest': candidate['digest'], 'checks': checks, 'runs': runs})
    submitted = {key: review[key] for key in ('workspaceDigest', 'decision', 'summary', 'issues', 'citations', 'basicReview')}
    current = (review.get('scopeDigest') == scope_digest(task) and valid_delivery_review(submitted, bundle['files'], candidate['digest']) is not None
               and basic_current(task, review, judge_digest) and validation.get('valid') is True)
    evidence = []
    for ref in review['basicReview']['references']:
        if ref['kind'] == 'project_check':
            check = next((item for item in reversed(checks) if item['receiptId'] == ref['id']), {})
            evidence.append({**ref, 'status': check.get('status', 'MISSING'), 'exitCode': check.get('exitCode'), 'snapshotDigest': check.get('snapshotDigest')})
        else:
            run = next((item for item in runs if item['runId'] == ref['id']), {})
            evidence.append({**ref, 'status': run.get('status', 'MISSING'), 'candidateDigest': run.get('candidateDigest'),
                'matchesCurrentConfiguration': run.get('matchesCurrentConfiguration', False)})
    return {'approved': current and review['decision'] == 'RECOMMEND' and review['basicReview']['status'] == 'SUFFICIENT', 'review': review,
        'report': {'status': review['basicReview']['status'] if current else 'STALE', 'reviewId': review['id'], 'scope': review['basicReview']['scope'],
            'reason': review['basicReview']['reason'], 'coversTaskScope': current and review['basicReview'].get('coversTaskScope') is True, 'evidence': evidence,
            'note': '仅描述审查所述的基础验证范围；不代表其他能力、效果目标或正式验收已通过。详细执行记录保留在任务中。'}}


def effect_report(task, review, judge_digest):
    scope_current = review.get('scopeDigest') == scope_digest(task)
    def find(identifier):
        return next((run for run in task['runs'] if run['id'] == identifier), None)
    before, after, incumbent = (find(review.get(key)) for key in ('baselineRunId', 'candidateRunId', 'incumbentRunId'))
    configuration_current = bool(after and after['candidateDigest'] == review['candidateDigest'] and development_current(task, after, judge_digest))
    base = {**review, 'scopeCurrent': scope_current, 'configurationCurrent': configuration_current}
    incomplete = {**base, 'evidenceStatus': 'INCOMPLETE'}
    if not scope_current or not configuration_current:
        return {**base, 'evidenceStatus': 'STALE'}
    goal_only = review.get('assessmentMode') == 'GOAL'
    if not after or not goal_only and (not before or not incumbent):
        return incomplete
    if 'targetPassRate' not in review and review['goal'] != task['goal']:
        return incomplete
    if 'targetPassRate' in review:
        owner = next((item.get('optimization') for item in task['attempts'] if item['id'] == review.get('optimizationOwnerAttemptId')), None)
        if not owner or owner['goal']['goal'] != review['goal'] or owner['goal'].get('targetPassRate') != review['targetPassRate'] or fingerprint(owner['goal'].get('protectedCaseIds', [])) != fingerprint(review.get('protectedCaseIds', [])) or any(
                not any(fingerprint(item) == fingerprint(change) for item in owner.get('contextChanges', [])) for change in review.get('contextChanges', [])):
            return incomplete
    try:
        baseline, candidate, prior = (optimization_evaluation(task, run) if run else None for run in (before, after, incumbent))
        changes = review.get('contextChanges', [])
        from improvement.policy import select_goal
        compatible = comparable(candidate, candidate) if goal_only else comparable(baseline, candidate, changes) and comparable(prior, candidate, changes)
        verified = select_goal(candidate, review['review']) if goal_only else select(baseline, candidate, prior, review['review'], review.get('protectedCaseIds', []), changes)
        same = all(verified[key] == review['decision'][key] for key in ('selected', 'continued', 'regressedCaseIds'))
        references = review['review']['review']['evidenceIds'] if review['review']['status'] == 'PRODUCED' else []
        complete = compatible and bool(references) and len(set(references)) == len(references) and all(any(item['id'] == identifier for item in candidate['cases']) for identifier in references) and review['review']['review']['recommendation'] != 'INCONCLUSIVE'
        measured = sum(item['passed'] is True for item in candidate['cases']) / len(candidate['cases']) if candidate['cases'] and all(item['passed'] is not None for item in candidate['cases']) else None
        return {**base, 'evidenceStatus': 'CHECKED' if same and complete else 'INCOMPLETE', 'measuredPassRate': measured,
            'targetReached': verified['selected'] and measured >= review['targetPassRate'] if 'targetPassRate' in review and measured is not None else None}
    except (ValueError, KeyError, TypeError):
        return incomplete


def approved_plan(task):
    if not task.get('analysis'):
        return False
    revision = next((item for item in task.get('planRevisions', []) if item['id'] == task.get('planRevisionId')), None)
    return bool(revision and revision.get('approvedAt') and revision['digest'] == fingerprint(task['analysis']))


def candidate_plan_current(task):
    if not task.get('planRevisionId'):
        return True
    candidate = current_candidate(task)
    if not candidate:
        return False
    return candidate.get('planRevisionId') == task.get('planRevisionId') if candidate.get('draft') else approved_plan(task) and candidate.get('planRevisionId') == task.get('planRevisionId')


def verify_delivery(task, bundle, judge_digest, basic=None):
    candidate = current_candidate(task)
    if (not candidate or candidate['digest'] != bundle['digest'] or not candidate_plan_current(task) or not task.get('configuration') or not task.get('suite')
            or any(item['status'] == 'RUNNING' for item in task['attempts']) or any(item.get('automatic', {}).get('status') in ('QUEUED', 'RUNNING') for item in task.get('runtimeBuildRequests', []))
            or task.get('selectedRuntimeBuildRequestId') and builder_status(task) != 'BOUND'):
        return None
    basic = basic or basic_report(task, candidate, bundle, judge_digest)
    if not basic['approved'] or basic['report'].get('coversTaskScope') is not True:
        return None
    review = next((item for item in reversed(task.get('effectReviews', [])) if item['candidateDigest'] == candidate['digest']), None)
    if not review:
        return None
    effect = effect_report(task, review, judge_digest)
    if effect['evidenceStatus'] != 'CHECKED' or not effect['decision']['selected'] or effect.get('measuredPassRate') is None:
        return None
    development = next((run for run in task['runs'] if run['id'] == effect['candidateRunId']), None)
    if not development or development['candidateId'] != candidate['id'] or not development.get('runtimeSnapshot'):
        return None
    selected, holdout_evidence = development, None
    if task['suite'].get('holdoutCases'):
        holdout = next((run for run in reversed(task['runs']) if run['phase'] == 'holdout' and run.get('purpose') != 'baseline'
            and run['candidateId'] == candidate['id'] and run['candidateDigest'] == candidate['digest'] and run.get('judgeDigest') == judge_digest
            and run.get('runtimeSelectionRevision') == task.get('runtimeSelectionRevision')
            and run.get('builderBindingId') == (task.get('runtimeDelivery', {}).get('id') if task.get('selectedRuntimeBuildRequestId') else None)
            and run['configurationDigest'] == fingerprint(task['configuration']) and run_suite_matches(task['suite'], run)), None)
        group = completed_repetitions(task, holdout, 'effect') if holdout else None
        if not holdout or not holdout.get('runtimeSnapshot') or fingerprint(holdout['runtimeSnapshot']) != fingerprint(development['runtimeSnapshot']) or not group:
            return None
        selected = holdout
        holdout_evidence = {'caseIds': [item['id'] for item in task['suite']['holdoutCases']],
            'runs': [[{'id': result['id'], 'passed': result['passed'], 'unverified': result.get('unverified', False), 'failureStage': result.get('failureStage')} for result in run['cases']] for run in group]}
    decision = delivery_decision({'basic': {'approved': basic['approved'], 'coversTaskScope': basic['report']['coversTaskScope']},
        'effect': {'evidenceStatus': effect['evidenceStatus'], 'selected': effect['decision']['selected'], 'measuredPassRate': effect['measuredPassRate'],
            'targetPassRate': effect.get('targetPassRate'), 'targetReached': effect.get('targetReached')}, 'holdout': holdout_evidence})
    return {'run': selected, 'basic': basic['report'], 'effect': effect, 'rates': decision['rates']} if decision['approved'] else None
