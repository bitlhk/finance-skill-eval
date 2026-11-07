"""Business baseline and candidate evaluation share this fixed execution program.

The main migration Agent chooses when evaluation is needed. This service freezes
the inputs, executes real cases, records cleanup, and judges evidence. It neither
edits the engineering workspace nor starts an optimization Agent.
"""
from copy import deepcopy
from uuid import uuid4

from tasks.application_host import call, dispatch, CapabilityError, run_program
from tasks.values import now
from evaluation.orchestration import execute as aggregate
from evaluation.checks import json_equal
from .state import MigrationControlError


def run(request):
    context = yield call('describe')
    total = context['suite'].get('executionRepetitions', 1)
    if type(total) is not int or not 1 <= total <= 5:
        raise ValueError('Invalid execution repetitions')
    group_id = 'execution-group-' + str(uuid4())
    for index in range(1, total + 1):
        repetition = {'groupId': group_id, 'index': index, 'total': total} if total > 1 else None
        result = yield from run_once(context, repetition)
        if result['status'] == 'INCOMPLETE' and (len(result['cases']) != len(context['cases'])
                or any(case.get('failureStage') for case in result['cases'])):
            break


def run_once(context, repetition):
    candidate, configuration = context['candidate'], context['configuration']
    bundle, purpose, cases = context['bundle'], context['purpose'], context['cases']
    if bundle['digest'] != candidate['digest']:
        raise MigrationControlError('冻结文件与评测版本摘要不一致')
    requirements = context.get('requirements', [])
    authored = context['authoredCases']
    if purpose == 'candidate' and any(identifier not in {item['id'] for item in requirements}
            for case in authored for identifier in case.get('requirementIds', [])):
        raise MigrationControlError('测试案例引用了当前方案之外的要求，请重新关联')
    run = {key: deepcopy(context[key]) for key in ('configurationDigest', 'suiteDigest', 'phase', 'suite')}
    run.update(id='bundle-run-' + str(uuid4()), candidateId=candidate['id'], candidateDigest=candidate['digest'],
               configuration=deepcopy(configuration), purpose=purpose, assessmentRequirements=deepcopy(requirements),
               status='RUNNING', createdAt=now(), cases=[])
    for key in ('judgeDigest', 'runtimeSelectionRevision', 'builderBindingId'):
        if context.get(key) is not None:
            run[key] = context[key]
    if candidate.get('tools') is not None:
        run['assessmentTools'] = deepcopy(candidate['tools'])
    if repetition:
        run['repetition'] = repetition

    def effect(name, *, cleanup=False, **inputs):
        return call(name, {'runId': run['id'], **inputs}, cleanup=cleanup)

    def save(*, cleanup=False):
        return effect('save_run', run=deepcopy(run), cleanup=cleanup)

    yield effect('register_run', run=deepcopy(run))
    receipts, incomplete = [], False
    for case in cases:
        yield effect('progress', case=case)
        try:
            opened = yield effect('open_runtime')
        except CapabilityError as error:
            incomplete = True
            if error.detail.get('runtimeFailureSnapshot') is not None:
                run['runtimeFailureSnapshot'] = error.detail['runtimeFailureSnapshot']
            run['cases'].append({'id': case['caseId'], 'passed': False, 'reason': str(error), 'failureStage': 'RUNTIME'})
            yield save(cleanup=True)
            if error.detail.get('aborted'):
                raise
            continue

        evidence = composition = None
        admitted = False
        try:
            snapshot = opened['environmentSnapshot']
            if 'runtimeSnapshot' in run and not json_equal(run['runtimeSnapshot'], snapshot):
                raise MigrationControlError('运行环境在验收过程中发生变化，请重新验收')
            run['runtimeSnapshot'] = snapshot
            if purpose == 'candidate':
                yield effect('admit_runtime', environmentSnapshot=snapshot)
            admitted = True
            evidence = yield effect('execute_case', case=case)
            requested = next((item.get('requirementIds', []) for item in authored if item['id'] == case['caseId']), [])
            assessment = yield effect('assess_case', case=case, evidence=evidence,
                                      requirements=[item for item in requirements if item['id'] in requested])
            composition = assessment.get('judgeComposition')
            if assessment.get('error'):
                raise CapabilityError(assessment['error'])
            verdict, checks = assessment['verdict'], assessment['executionChecks']
            incomplete |= assessment['incomplete']
            verified = bool(checks) and all(item['status'] == 'PASS' for item in checks if item['id'] != 'execution.completed')
            identity = yield effect('judge_identity')
            if run.get('judgeDigest') != identity:
                raise MigrationControlError('Judge 配置在验收期间发生变化，请重新验收')
            result = {'id': case['caseId'], **verdict, 'evidence': evidence, 'executionChecks': checks,
                      'methodResults': assessment['methodResults']}
            if composition:
                result['judgeComposition'] = composition
            if assessment['judgeFailed']:
                result['failureStage'] = 'JUDGE'
            elif not assessment['valid']:
                result['failureStage'] = 'EXECUTION' if verified else 'RUNTIME'
            run['cases'].append(result)
            yield effect('log_case', case=case, result=result, cleanup=True)
        except (CapabilityError, MigrationControlError) as error:
            incomplete = True
            if not admitted:
                run['runtimeFailureSnapshot'] = opened['environmentSnapshot']
            result = {'id': case['caseId'], 'passed': False, 'reason': str(error),
                      'failureStage': 'JUDGE' if evidence is not None else 'RUNTIME'}
            if evidence is not None:
                result['evidence'] = evidence
            if composition:
                result['judgeComposition'] = composition
            run['cases'].append(result)
            if isinstance(error, CapabilityError) and error.detail.get('aborted'):
                raise
        finally:
            # Every opened runtime is closed, also on failed admission/cancellation.
            # The receipt is persisted before a cleanup failure leaves the program.
            closed = yield effect('close_runtime', cleanup=True)
            receipts.append(closed.get('receipt', {'status': 'UNKNOWN'}))
            run['finalization'] = deepcopy(receipts)
            yield save(cleanup=True)
            if closed.get('error'):
                raise CapabilityError(closed['error'])
        if not admitted:
            break
        state = ((run['cases'][-1].get('evidence') or {}).get('metadata') or {}).get('caseState')
        if state and state.get('status') != 'COMPLETE':
            break

    passed = len(run['cases']) == len(cases) and all(case['passed'] for case in run['cases'])
    run['effectStatus'] = 'INCOMPLETE' if incomplete else 'PASSED' if passed else 'FAILED'
    if requirements:
        run['requirementCoverage'] = aggregate({'action': 'requirement_coverage', 'requirements': requirements,
            'plannedCases': [{'id': case['id'], 'requirementIds': case.get('requirementIds', [])} for case in authored],
            'cases': run['cases']})
        incomplete |= any(item['status'] == 'UNVERIFIED' for item in run['requirementCoverage'])
    run['status'] = ('INCOMPLETE' if incomplete else 'FAILED'
                     if any(item['status'] == 'FAILED' for item in run.get('requirementCoverage', []))
                     else 'PASSED' if passed else 'FAILED')
    run['finishedAt'] = now()
    yield save()
    return run


def execute(request):
    return dispatch(request, {'run': run})


async def accept(handlers):
    """Python service/Agent tools use direct adapters, without a process bridge."""
    return await run_program(run({}), handlers)
