"""Native adapters for the existing fixed baseline/candidate evaluation program."""
from agents.criterion import judge_identity
from api.contracts import parse
from evaluation.execution import execute_case
from evaluation.packs import suite_cases
from evaluation.task_case import assess_task_case
from tasks.application_host import CapabilityError
from tasks.values import fingerprint

from .acceptance import accept
from .facts import current_candidate, suite_digest, require_binding
from .plan_review import review_environment
from .runtime import create_runtime
from .state import MigrationControlError


async def evaluate_task(service, task, attempt, phase='development', purpose='candidate'):
    preparation = (task.get('preparations') or [None])[-1] if purpose == 'baseline' else None
    if purpose == 'baseline' and (not preparation or not task.get('baselineConfiguration')):
        raise MigrationControlError('请先准备完整工程并配置原工程基线')
    candidate = {'id': preparation['id'], 'digest': preparation['digest'], 'services': []} if preparation else current_candidate(task)
    if not candidate:
        raise MigrationControlError('当前没有待评测版本')
    configuration = task['baselineConfiguration' if purpose == 'baseline' else 'configuration']
    suite = parse('migration_suite', task['suite'])
    bundle = await service.repository.read_snapshot(task['id'], candidate['id'])
    project = purpose == 'baseline' or configuration.get('executionMode') == 'agent_project'
    context = {'candidate': candidate, 'configuration': configuration, 'suite': suite, 'bundle': bundle, 'purpose': purpose, 'phase': phase,
        'configurationDigest': fingerprint(configuration), 'suiteDigest': suite_digest(suite), 'judgeDigest': service.judge_identity(),
        **({'runtimeSelectionRevision': task['runtimeSelectionRevision']} if 'runtimeSelectionRevision' in task else {}),
        **({'builderBindingId': task['runtimeDelivery']['id']} if purpose == 'candidate' and task.get('selectedRuntimeBuildRequestId') else {}),
        'requirements': ((task.get('analysis') or {}).get('standardization') or {}).get('requirements', []) if purpose == 'candidate' else [],
        'cases': suite_cases(suite, holdout=phase == 'holdout'), 'authoredCases': suite.get('holdoutCases', []) if phase == 'holdout' else suite['cases']}
    opened = None
    async def handle(name, inputs):
        nonlocal opened
        run_id, case = inputs.get('runId'), inputs.get('case')
        if name == 'describe':
            return context
        if name in ('register_run', 'save_run'):
            def update(current):
                if name == 'register_run':
                    current['runs'].append(inputs['run'])
                    next(item for item in current['attempts'] if item['id'] == attempt['id'])['runId'] = run_id
                else:
                    index = next((index for index, run in enumerate(current['runs']) if run['id'] == run_id), None)
                    if index is None:
                        raise MigrationControlError('评测记录不存在')
                    current['runs'][index] = inputs['run']
            await service.repository.update(task['id'], update)
        elif name == 'progress':
            await service.progress(task['id'], attempt['id'], ('开发集评测：' if attempt['kind'] == 'CHAT' else '联合验收：') + case['caseId'])
        elif name == 'open_runtime':
            try:
                opened = await service.runtime(bundle, configuration, candidate.get('services', []), execution_mode='agent_project' if project else None)
            except Exception as error:
                raise CapabilityError({'message': str(error), 'name': type(error).__name__,
                    **({'runtimeFailureSnapshot': error.runtime_failure_snapshot} if getattr(error, 'runtime_failure_snapshot', None) else {})}) from error
            return {'environmentSnapshot': opened['environmentSnapshot']}
        elif name == 'admit_runtime':
            require_binding(task, inputs['environmentSnapshot'])
            if review_environment(task, inputs['environmentSnapshot'])['status'] == 'FAILED':
                raise MigrationControlError('运行环境不满足当前方案的能力要求')
        elif name == 'execute_case':
            if opened is None:
                raise RuntimeError('Runtime is not open')
            await opened['runtime'].prepare({'runId': run_id})
            return await execute_case(opened['runtime'], {'runId': run_id, 'side': 'right', 'model': opened['model'],
                'variant': {'mode': 'skill_version', 'skillId': task['id'], 'version': candidate['id'], 'artifactSha256': bundle['digest']}, 'evalCase': case})
        elif name == 'assess_case':
            receipt = None
            def composition(value):
                nonlocal receipt
                receipt = value
            result = await assess_task_case(case, inputs['evidence'], expected={'contentDigest': bundle['digest'], 'members': bundle['members'],
                **({'executionMode': 'agent_project'} if project else {})}, requirements=inputs['requirements'], tools=candidate.get('tools'),
                judge=service.judge, on_composition=composition)
            return {**result, **({'judgeComposition': receipt} if receipt else {})}
        elif name == 'judge_identity':
            return service.judge_identity()
        elif name == 'close_runtime':
            current, opened = opened, None
            error = None
            try:
                if current:
                    await current['runtime'].cleanup()
            except Exception as failure:
                error = {'message': str(failure)}
            return {'receipt': current['runtime'].finalization_evidence() if current else {'status': 'UNKNOWN'}, **({'error': error} if error else {})}
        elif name != 'log_case':
            raise ValueError('Unknown acceptance capability: ' + name)
    names = ('describe', 'register_run', 'save_run', 'progress', 'open_runtime', 'admit_runtime', 'execute_case', 'assess_case', 'judge_identity', 'close_runtime', 'log_case')
    return await accept({name: (lambda inputs, name=name: handle(name, inputs)) for name in names})
