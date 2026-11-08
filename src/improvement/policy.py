"""Evidence and review gates shared by optimization scenarios."""
import math
import json
from copy import deepcopy
from evaluation.checks import comparison_incomplete


def comparison_evaluation(job, candidate, ids, protocol_digest):
    """Bind comparison evidence to the candidate before optimization or Review."""
    repetitions = job['configuration'].get('executionRepetitions', 1)
    result = {'id': job['jobId'], 'candidate': deepcopy(candidate), 'protocolDigest': protocol_digest, 'cases': []}
    if repetitions > 1:
        attempts = []
        for index in range(repetitions):
            attempt = next((item for item in job.get('executionAttempts', []) if item['index'] == index), None)
            attempts.append(comparison_evaluation({**job, 'configuration': {**job['configuration'], 'executionRepetitions': 1},
                'report': attempt['report']}, candidate, ids, protocol_digest) if attempt and attempt['status'] == 'COMPLETED'
                and attempt.get('report') and not comparison_incomplete(attempt['report']) else None)
        for case_id in ids:
            cases = [next((case for case in attempt['cases'] if case['id'] == case_id), None) if attempt else None for attempt in attempts]
            result['cases'].append({'id': case_id,
                'passed': None if any(case is None or case['passed'] is None for case in cases) else all(case['passed'] is True for case in cases),
                'observation': [deepcopy(case.get('observation')) if case else None for case in cases]})
        return result
    report = job.get('report') or {}
    variant = (report.get('variants') or {}).get('right') or {}
    selected = [case for case in report.get('cases', []) if case['caseId'] in ids]
    unique = len({case['caseId'] for case in selected}) == len(selected)
    for case_id in ids:
        case = next((case for case in selected if case['caseId'] == case_id), None)
        judge, right = ((case or {}).get('judge') or {}), ((case or {}).get('right') or {})
        verdict = (judge.get('goalAssessment') or {}).get('verdict') or (judge.get('serviceComparison') or {}).get('verdict')
        artifact_verified = variant.get('mode') == 'skill_version' and (variant.get('artifactSha256') == candidate['digest']
            or (right.get('metadata') or {}).get('skillArtifactSha256') == candidate['digest'])
        complete = unique and artifact_verified and right.get('status') == 'completed' and right.get('runtimeIdentityVerified') and right.get('streamCompleted') and judge and not case.get('judgeError')
        passed = None
        if complete:
            if verdict:
                passed = None if verdict == 'INDETERMINATE' else verdict == 'PASS'
            elif judge.get('dimensions'):
                passed = all(type(d.get('rightScore')) in (int, float) and math.isfinite(d['rightScore']) and d['rightScore'] >= 3 for d in judge['dimensions'])
        specification = next((c for c in (job.get('evaluationSpec') or {}).get('cases', []) if c['caseId'] == case_id), {})
        # Answer quality cannot override failed process/identity/state criteria.
        # Optional user-plan checks are handled separately below.
        for method in ((case or {}).get('methodResults') or {}).get('right', []):
            if method['methodId'].startswith('plan:'):
                continue
            if method['status'] not in ('PASS', 'FAIL') or any(c['status'] == 'UNVERIFIED' for c in method['checks']):
                passed = None
                break
            if method['status'] == 'FAIL' and passed is not None:
                passed = False
        for check in (specification.get('evaluationPlan') or {}).get('checks', []):
            if not check.get('required', True):
                continue
            method = next((m for m in ((case or {}).get('methodResults') or {}).get('right', []) if m['methodId'] == 'plan:' + check['id']), None)
            if not method or method['status'] not in ('PASS', 'FAIL') or any(c['status'] == 'UNVERIFIED' for c in method['checks']):
                passed = None
                break
            if method['status'] == 'FAIL' and passed is not None:
                passed = False
        result['cases'].append({'id': case_id, 'passed': passed, **({'observation': deepcopy(case)} if case is not None else {})})
    return result


def review_input(goal, before, after, changes, context=None):
    """Build the same independent review material for migration and optimization."""
    context = context or {}
    incumbent = context.get('incumbent') or before
    context_changes = context.get('contextChanges', [])
    can_compare = before is not None and comparable(before, after, context_changes) and comparable(incumbent, after, context_changes)
    def summarize(evaluation):
        cases = evaluation['cases']
        total = len(cases)
        passed = sum(item.get('passed') is True for item in cases)
        failed = sum(item.get('passed') is False for item in cases)
        incomplete = total - passed - failed
        return {'total': total, 'passed': passed, 'failed': failed, 'incomplete': incomplete,
                'passRate': passed / total if total and not incomplete else None}
    result = {'goal': goal, 'candidateDigest': after['candidate']['digest'], 'changes': changes,
              'evaluationSummary': {'scope': 'SELECTED_DEVELOPMENT_SET', 'candidate': summarize(after)},
              'protectedCaseIds': context.get('protectedCaseIds', []), 'evidence': []}
    if before is None:
        result['assessmentMode'] = 'GOAL'
    else:
        result.update(baselineDigest=before['candidate']['digest'], incumbentDigest=incumbent['candidate']['digest'])
        result['evaluationSummary'].update(baseline=summarize(before), incumbent=summarize(incumbent))
    for name in ('targetPassRate', 'remainingRounds', 'contextChanges'):
        if name in context:
            result[name] = context[name]
    assessments = {'baseline': before, 'candidate': after, 'incumbent': incumbent}
    if any(item and 'basicValidation' in item for item in assessments.values()):
        result['basicValidation'] = {name: item['basicValidation'] for name, item in assessments.items() if item and 'basicValidation' in item}
    for case in after['cases']:
        previous = next((item for item in (before or {}).get('cases', []) if item['id'] == case['id']), None)
        working = next((item for item in (incumbent or {}).get('cases', []) if item['id'] == case['id']), None)
        summary = {}
        if previous is not None:
            summary['before'] = previous['passed']
        summary['after'] = case['passed']
        if working is not None:
            summary['incumbent'] = working['passed']
        item = {'evidenceId': case['id'], 'evaluationDigest': after['protocolDigest'],
                'completed': case['passed'] is not None, **({'comparable': can_compare} if before is not None else {}),
                'summary': json.dumps(summary, ensure_ascii=False, separators=(',', ':'), allow_nan=False)}
        for name, source in (('baseline', previous), ('candidate', case), ('incumbent', working)):
            if source is not None and 'observation' in source:
                item[name] = source['observation']
        result['evidence'].append(item)
    return deepcopy(result)


def review_input_gate(evidence, mode='COMPARISON'):
    ids = [item['evidenceId'] for item in evidence]
    if len(set(ids)) != len(ids):
        raise ValueError('Duplicate review evidence')
    if not ids or any(not item['completed'] or mode != 'GOAL' and not item.get('comparable') for item in evidence):
        return {'status': 'ABSTAINED', 'reason': '缺少已完成的目标评测证据' if mode == 'GOAL' else '缺少已完成且可比的候选评测证据'}
    return None


def validate_review_references(evidence, result):
    if result['status'] != 'PRODUCED':
        return result
    ids = [item['evidenceId'] for item in evidence]
    references = result['review']['evidenceIds']
    if len(set(references)) != len(references) or any(item not in set(ids) for item in references):
        raise ValueError('Review cites unknown or duplicate evidence')
    return result


def comparable(before, after, changes=()):
    protocols = {before['protocolDigest']}
    criteria = before.get('criteriaDigest')
    if criteria and criteria == after.get('criteriaDigest'):
        for _ in changes:
            for change in changes:
                if change.get('criteriaDigest') != criteria:
                    continue
                if change['beforeProtocolDigest'] in protocols:
                    protocols.add(change['afterProtocolDigest'])
                if change['afterProtocolDigest'] in protocols:
                    protocols.add(change['beforeProtocolDigest'])
    left, right = before['cases'], after['cases']
    left_ids = [case['id'] for case in left]
    right_ids = [case['id'] for case in right]
    return (after['protocolDigest'] in protocols and bool(left) and len(left) == len(right)
            and len(set(left_ids)) == len(left_ids) and len(set(right_ids)) == len(right_ids)
            and set(left_ids) == set(right_ids)
            and all(case.get('passed') is not None for case in left + right))


def regressions(before, after):
    failed = {case['id'] for case in after['cases'] if case.get('passed') is False}
    return [case['id'] for case in before['cases'] if case.get('passed') is True and case['id'] in failed]


def select(before, after, incumbent, review, protected=(), changes=()):
    regressed = list(dict.fromkeys(regressions(before, after) + regressions(incumbent, after)))
    if not comparable(before, after, changes) or not comparable(incumbent, after, changes):
        return {'selected': False, 'continued': False, 'regressedCaseIds': regressed, 'reason': '评测未完成或条件不可比'}
    return _review_decision(after, review, protected, regressed)


def select_goal(after, review, protected=()):
    if (not comparable(after, after) or review.get('status') == 'PRODUCED' and
            (review['review'].get('improvements') or review['review'].get('regressions') or review['review']['recommendation'] == 'KEEP_BASELINE')):
        return {'selected': False, 'continued': False, 'regressedCaseIds': [], 'reason': '目标审查需要完整证据，不能声称未对比的提升或回退'}
    return _review_decision(after, review, protected, [])


def _review_decision(after, review, protected, regressed):
    def reject(reason):
        return {'selected': False, 'continued': False, 'regressedCaseIds': regressed, 'reason': reason}
    passed = {case['id'] for case in after['cases'] if case.get('passed') is True}
    violations = [case_id for case_id in protected if case_id not in passed]
    if violations:
        return reject('未满足明确指定的必须通过案例：' + '、'.join(violations))
    if review['status'] == 'ABSTAINED':
        return reject(review['reason'])
    result = review['review']
    selected = result['recommendation'] == 'KEEP_CANDIDATE'
    continued = result['recommendation'] == 'CONTINUE_CANDIDATE'
    if not selected and not continued:
        return reject(result['reason'])
    evidence = result.get('evidenceIds', [])
    available = {case['id'] for case in after['cases']}
    if not evidence or len(set(evidence)) != len(evidence) or any(item not in available for item in evidence):
        return reject('审查缺少有效证据引用')
    if regressed and (not result.get('tradeoff', '').strip() or not result.get('regressions')):
        return reject('审查需说明回退及其与优化目标之间的取舍')
    if continued and not any(focus.strip() for focus in result.get('nextFocus', [])):
        return reject('继续修复需要明确下一轮修复方向')
    return {'selected': selected, 'continued': continued, 'regressedCaseIds': regressed, 'reason': result['reason']}


def holdout_goal(cases, target):
    if (isinstance(target, bool) or not isinstance(target, (int, float)) or not math.isfinite(target)
            or not 0 <= target <= 1 or not isinstance(cases, list) or not cases):
        return False
    identifiers = [case.get('id') for case in cases if isinstance(case, dict)]
    if (len(identifiers) != len(cases) or any(not isinstance(item, str) or not item for item in identifiers)
            or len(set(identifiers)) != len(identifiers) or any(type(case.get('passed')) is not bool for case in cases)):
        return False
    return sum(case['passed'] for case in cases) / len(cases) >= target


def execute(request):
    action = request['action']
    if action == 'comparison_evaluation':
        return comparison_evaluation(request['job'], request['candidate'], request['ids'], request['protocolDigest'])
    if action == 'review_input':
        return review_input(request['goal'], request['before'], request['after'], request['changes'], request.get('context'))
    if action == 'review_input_gate':
        return review_input_gate(request['evidence'])
    if action == 'validate_review_references':
        return validate_review_references(request['evidence'], request['result'])
    if action == 'comparable':
        return comparable(request['before'], request['after'], request.get('changes', []))
    if action == 'select':
        return select(request['before'], request['after'], request['incumbent'], request['review'],
                      request.get('protected', []), request.get('changes', []))
    if action == 'holdout_goal':
        return holdout_goal(request['cases'], request['target'])
    raise ValueError('Unknown optimization policy action')
