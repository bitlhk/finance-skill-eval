"""Plan and aggregate evaluation methods; execution remains behind ports."""
import math
import asyncio
import inspect
from copy import deepcopy
from time import monotonic
from tasks.values import now, fingerprint
from .checks import evaluate_check, check_references, validate_citations
from .evidence import resources
from tasks.application_host import call, dispatch, CapabilityError, run_program


def validate(methods):
    preceding = set()
    for method in methods:
        identity = method['id']
        if identity in preceding:
            raise ValueError('Duplicate evaluation method')
        if any(dependency not in preceding for dependency in method.get('dependsOn', [])):
            raise ValueError('Evaluation dependencies must precede their consumer')
        if 'timeoutMs' in method:
            timeout = method['timeoutMs']
            if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or timeout <= 0:
                raise ValueError('Invalid evaluation timeout')
        preceding.add(identity)


def method_program(request):
    """Single method execution policy for native callers and transitional ports."""
    eval_case, evidence, methods = request['evalCase'], request['evidence'], request['methods']
    validate(methods)
    results = []
    digest = request.get('evidenceDigest') or fingerprint(evidence)
    for index, method in enumerate(methods):
        started = monotonic()
        identity = {'methodId': method['id'], 'version': method['version'], 'kind': method['kind'],
                    'evidenceDigest': digest, 'startedAt': now()}
        next_ = execute({'action': 'next', 'methods': methods, 'results': results})
        if next_['kind'] == 'SKIP':
            result = {**identity, 'status': 'SKIP', 'checks': [], 'reason': next_['reason']}
        else:
            try:
                checks = yield call('evaluate', {'index': index, 'timeoutMs': method.get('timeoutMs', 60000),
                                                'evalCase': deepcopy(eval_case), 'evidence': deepcopy(evidence)})
                result = {**identity, **execute({'action': 'complete', 'checks': checks})}
            except Exception as error:
                if isinstance(error, CapabilityError) and error.detail.get('aborted'):
                    raise
                result = {**identity, 'status': 'ERROR', 'checks': [],
                          'reason': 'Evaluation method timed out' if isinstance(error, TimeoutError) else str(error)}
        result['durationMs'] = round((monotonic() - started) * 1000)
        results.append(result)
    return results


def execute_methods(request):
    return dispatch(request, {'run': method_program})


async def evaluate_methods(eval_case, evidence, methods):
    """Use the same program with direct Python calls and native cancellation."""
    async def invoke(inputs):
        await asyncio.sleep(0)
        try:
            async with asyncio.timeout(inputs['timeoutMs'] / 1000):
                result = methods[inputs['index']]['evaluate']({'evalCase': inputs['evalCase'], 'evidence': inputs['evidence']})
                return await result if inspect.isawaitable(result) else result
        except TimeoutError as error:
            raise RuntimeError('Evaluation method timed out') from error
    return await run_program(method_program({'evalCase': eval_case, 'evidence': evidence, 'methods': methods}), {'evaluate': invoke})


def planned_methods(plan, script_executor=None):
    """Build plan methods; script execution is supplied by the isolated executor."""
    methods = []
    for supplied in (plan or {}).get('checks', []):
        check = deepcopy(supplied)
        async def evaluate(inputs, check=check):
            material = resources(inputs['evidence'])
            if check.get('rule'):
                return [evaluate_check(check, material)]
            if not check_references(check.get('evidenceRefs', []), material)['available']:
                return [{'id': check['id'], 'status': 'UNVERIFIED',
                         'reason': 'Required evidence is unavailable', 'evidenceRefs': []}]
            if script_executor is None:
                raise RuntimeError('Isolated verifier executor is not configured')
            receipt = await script_executor(check['script'], material, check.get('timeoutMs', 60000))
            return validate_citations(receipt, material)['checks']
        methods.append({'id': 'plan:' + check['id'], 'version': check['version'], 'kind': check['kind'],
                        'timeoutMs': check.get('timeoutMs', 60000), 'evaluate': evaluate})
    return methods


def execute(request):
    action = request['action']
    if action == 'validate':
        validate(request['methods'])
        return None
    if action == 'next':
        methods = request['methods']
        results = request['results']
        if len(results) >= len(methods):
            return {'kind': 'DONE'}
        method = methods[len(results)]
        statuses = {result['methodId']: result['status'] for result in results}
        if any(statuses.get(dependency) != 'PASS' for dependency in method.get('dependsOn', [])):
            return {'kind': 'SKIP', 'reason': 'Required evaluation method did not pass'}
        return {'kind': 'RUN'}
    if action == 'complete':
        checks = request['checks']
        ids = [check['id'] for check in checks]
        if len(set(ids)) != len(ids):
            raise ValueError('Duplicate evaluation check')
        status = ('FAIL' if any(check['status'] == 'FAIL' for check in checks) else
                  'UNVERIFIED' if not checks or any(check['status'] == 'UNVERIFIED' for check in checks) else 'PASS')
        return {'status': status, 'checks': checks}
    if action == 'requirement_coverage':
        coverage = []
        for requirement in request['requirements']:
            planned = [case['id'] for case in request.get('plannedCases', [])
                       if requirement['id'] in case.get('requirementIds', [])]
            checked = []
            for case in request['cases']:
                if 'plannedCases' in request and case['id'] not in planned:
                    continue
                matches = [result for result in case.get('requirementResults', []) if result['id'] == requirement['id']]
                if matches:
                    checked.append((case['id'], matches))
            outcomes = [result.get('passed') for _, results in checked for result in results]
            checked_ids = {case_id for case_id, _ in checked}
            missing = any(case_id not in checked_ids for case_id in planned)
            status = ('FAILED' if any(value is False for value in outcomes) else
                      'UNVERIFIED' if missing or not outcomes or any(value is not True for value in outcomes) else 'PASSED')
            item = {'id': requirement['id'], 'status': status, 'caseIds': [case_id for case_id, _ in checked]}
            if 'plannedCases' in request:
                by_id = dict(checked)
                item['plannedCaseIds'] = planned
                item['pendingCaseIds'] = [case_id for case_id in planned if case_id not in by_id or
                                          any(result.get('passed') is not True and result.get('passed') is not False
                                              for result in by_id[case_id])]
            coverage.append(item)
        return coverage
    if action == 'stability':
        attempts = request['attempts']
        ids = list(dict.fromkeys(case['caseId'] for attempt in attempts for case in attempt))
        result = []
        for case_id in ids:
            outcomes = [next((case.get('outcome') for case in attempt if case['caseId'] == case_id), None)
                        for attempt in attempts]
            counts = {}
            for outcome in outcomes:
                if outcome is not None:
                    counts[outcome] = counts.get(outcome, 0) + 1
            assessed = sum(outcome is not None for outcome in outcomes)
            result.append({'caseId': case_id, 'attempts': len(attempts), 'assessed': assessed,
                           'unavailable': len(attempts) - assessed, 'counts': counts,
                           'coverage': assessed / len(attempts) if attempts else 0,
                           'agreement': max(counts.values()) / assessed if assessed else None})
        return result
    raise ValueError('Unknown evaluation orchestration action')
