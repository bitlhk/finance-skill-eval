"""Aggregate execution, business judgement and explicit verification methods.

No new Judge: callers supply the original method results and model verdict.
Shared by live migration evaluation and frozen-evidence rescoring.
"""
from copy import deepcopy


def task_verdict(method_results, verdict, plan=None):
    verdict = deepcopy(verdict)
    by_id = {item['methodId']: item for item in method_results}
    execution, judge = by_id['bundle-execution'], by_id['business-judge']
    valid, judge_failed = execution['status'] == 'PASS', judge['status'] == 'ERROR'
    incomplete = not valid or judge_failed or any(check['status'] == 'UNVERIFIED' for check in judge['checks'])
    if judge_failed:
        verdict = {'passed': False, 'unverified': True, 'reason': judge['reason'] if judge.get('reason') is not None else '评判失败'}
    for check in (plan or {}).get('checks', []):
        result = by_id['plan:' + check['id']]
        if check['required'] and result['status'] != 'PASS':
            reason = result.get('reason')
            if reason is None:
                reason = '; '.join(item['reason'] for item in result['checks'])
            verdict.update(passed=False, reason=verdict['reason'] + '\n' + check['id'] + ': ' + reason)
            if result['status'] != 'FAIL' or any(item['status'] == 'UNVERIFIED' for item in result['checks']):
                incomplete = True
    return {'verdict': verdict, 'methodResults': method_results, 'valid': valid,
            'judgeFailed': judge_failed, 'incomplete': incomplete}


def execute(request):
    return task_verdict(request['methodResults'], request['verdict'], request.get('plan'))
