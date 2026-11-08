"""Repeat judgement of frozen evidence; never rerun the business Agent."""
from uuid import uuid4
from tasks.application_host import call, dispatch, run_program
from tasks.values import now, fingerprint
from copy import deepcopy
from .orchestration import execute as orchestration


def run(request):
    source, options = request['source'], request['request']
    spec = source['evaluationSpec']
    judge = yield call('judge_info')
    if options['alternateOrder'] and not judge['supportsPresentationOrder']:
        raise ValueError('当前 Judge 不支持 A/B 顺序交换')
    attempts = []
    for index in range(options['repetitions']):
        order = ('swapped' if index % 2 else 'normal') if options['alternateOrder'] else 'default'
        cases = []
        for original in source['report']['cases']:
            selected = next((case for case in spec['cases'] if case['caseId'] == original['caseId']), None)
            if selected is None:
                raise ValueError('冻结评判方案缺少案例')
            cases.append((yield call('judge_case', {'evalCase': selected, 'original': original, 'order': order})))
        attempts.append({'index': index, 'presentationOrder': order, 'cases': cases})
    record = {'id': 'rescore-' + str(uuid4()), 'createdAt': now(), 'sourceReportFingerprint': source['report']['reportFingerprint'],
        'judgeId': judge['judgeId'], 'judgeConfigurationDigest': judge['configurationDigest'], 'repetitions': len(attempts),
        'attempts': attempts, 'cases': attempts[0]['cases'], 'stability': orchestration({'action': 'stability', 'attempts': [
            [{'caseId': case['caseId'], 'outcome': (case.get('judge') or {}).get('winner')} for case in attempt['cases']] for attempt in attempts]})}
    yield call('commit_rescore', {'record': record})
    return record


def execute(request):
    return dispatch(request, {'run': run, 'single': single_run})


def single_run(request):
    """Grade a frozen single-runtime run using the live evaluation Judge port.

    No runtime port is supplied: repeating judgement cannot replay business
    side effects. The caller supplies parsed cases from the frozen suite.
    """
    source, options = deepcopy(request['source']), request['request']
    count = options.get('repetitions', 1)
    if type(count) is not int or not 1 <= count <= 5:
        raise ValueError('Assessment repetitions must be between 1 and 5')
    if source['status'] == 'RUNNING':
        raise ValueError('Select a finished run to rescore')
    cases = {case['caseId']: case for case in request['cases']}
    identity = yield call('judge_info')
    attempts = []
    for _ in range(count):
        judged = []
        for saved in source['cases']:
            case = cases.get(saved['id'])
            unavailable = None
            if not saved.get('evidence') or case is None:
                unavailable = '没有可重评的执行证据，请重新运行'
            elif request.get('requirementIds', {}).get(saved['id']) and 'assessmentRequirements' not in source:
                unavailable = '旧记录未冻结要求定义，需重新运行'
            if unavailable:
                judged.append({'id': saved['id'], 'status': 'UNVERIFIED', 'reason': unavailable, 'methodResults': []})
                continue
            selected = deepcopy(case)
            if options.get('evaluationPlan') is not None:
                selected['evaluationPlan'] = deepcopy(options['evaluationPlan'])
            ids = request.get('requirementIds', {}).get(saved['id'], [])
            evaluated = yield call('assess_case', {'evalCase': selected, 'evidence': deepcopy(saved['evidence']),
                'executionChecks': saved.get('executionChecks'),
                'requirements': [r for r in source['assessmentRequirements'] if r['id'] in ids]
                    if 'assessmentRequirements' in source else None,
                'tools': source.get('assessmentTools')})
            verdict = evaluated['verdict']
            result = {'id': saved['id'], 'status': 'UNVERIFIED' if evaluated['incomplete'] else 'PASS' if verdict['passed'] else 'FAIL',
                'reason': verdict['reason'], 'methodResults': evaluated['methodResults'], 'evidenceDigest': fingerprint(saved['evidence'])}
            for key in ('assessmentVersion', 'criteria', 'answerProvenance'):
                if key in verdict:
                    result[key] = verdict[key]
            if verdict.get('investigation'):
                result['judgeInvestigation'] = verdict['investigation']
            judged.append(result)
        if (yield call('judge_info')) != identity:
            raise ValueError('Judge configuration changed during rescoring')
        attempts.append({'id': 'rescore-' + str(uuid4()), 'sourceRunId': source['id'], 'sourceDigest': fingerprint(source),
            'createdAt': now(), 'cases': judged, **({'judgeDigest': identity} if identity is not None else {}),
            **({'plan': options['evaluationPlan']} if 'evaluationPlan' in options else {})})
    result = {**attempts[0], 'repetitions': len(attempts)}
    if len(attempts) > 1:
        result.update(attempts=attempts, stability=orchestration({'action': 'stability', 'attempts': [
            [{'caseId': case['id'], 'outcome': case['status'] if case['status'] in ('PASS', 'FAIL') else None}
             for case in attempt['cases']] for attempt in attempts]}))
    return result


async def rescore_single(source, options, cases, handlers, *, requirement_ids=None):
    return await run_program(single_run({'source': source, 'request': options, 'cases': cases,
                                       'requirementIds': requirement_ids or {}}), handlers)
