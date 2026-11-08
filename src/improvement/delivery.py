"""Combine scoped basic evidence and independently reviewed effect results."""
import math


def execute(request):
    basic, effect = request.get('basic') or {}, request.get('effect') or {}
    rejected = {'approved': False}
    if basic.get('approved') is not True or basic.get('coversTaskScope') is not True:
        return rejected
    if effect.get('evidenceStatus') != 'CHECKED' or effect.get('selected') is not True:
        return rejected
    target = effect.get('targetPassRate')
    development = effect.get('measuredPassRate')
    if (target is not None and (isinstance(target, bool) or not isinstance(target, (int, float))
            or not math.isfinite(target) or not 0 <= target <= 1)):
        return rejected
    if (isinstance(development, bool) or not isinstance(development, (int, float)) or not math.isfinite(development)
            or not 0 <= development <= 1 or (target is not None and development < target)):
        return rejected
    if effect.get('targetPassRate') is not None and effect.get('targetReached') is not True:
        return rejected
    holdout = request.get('holdout')
    rate = None
    if holdout is not None:
        if not isinstance(holdout,dict):
            return rejected
        ids, runs = holdout.get('caseIds'), holdout.get('runs')
        if (not isinstance(ids, list) or not ids or any(not isinstance(item,str) or not item for item in ids)
                or len(set(ids))!=len(ids) or not isinstance(runs,list) or not runs):
            return rejected
        observations=[]
        for run in runs:
            if not isinstance(run,list) or len(run)!=len(ids):
                return rejected
            by_id={}
            for case in run:
                if (not isinstance(case,dict) or case.get('id') not in ids or case['id'] in by_id
                        or case.get('failureStage') or case.get('unverified') or type(case.get('passed')) is not bool):
                    return rejected
                by_id[case['id']]=case['passed']
            observations.append(by_id)
        rate=sum(all(run[case_id] for run in observations) for case_id in ids)/len(ids)
        # A hidden set is not part of the reviewer's development evidence. If
        # no numerical goal was selected, failures there remain unreviewed.
        if rate < (target if target is not None else 1):
            return rejected
    return {'approved':True,'rates':{'target':target,'development':development,'holdout':rate}}
