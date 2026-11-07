"""Rescore saved migration evidence through the shared native evaluation pipeline."""
from evaluation.rescoring import rescore_single
from evaluation.packs import suite_cases
from evaluation.task_case import assess_task_case
from .state import MigrationControlError


async def rescore_task(service, task, request):
    source = next((run for run in task['runs'] if run['id'] == request['runId']), None)
    if not source:
        raise MigrationControlError('运行记录不存在', 404)
    async def assess(inputs):
        return await assess_task_case(inputs['evalCase'], inputs['evidence'], requirements=inputs.get('requirements') or [],
            tools=inputs.get('tools'), judge=service.judge, execution_checks_override=inputs.get('executionChecks'))
    authored = source['suite'].get('holdoutCases', []) if source['phase'] == 'holdout' else source['suite']['cases']
    return await rescore_single(source, request, suite_cases(source['suite'], holdout=source['phase'] == 'holdout'),
        {'assess_case': assess, 'judge_info': lambda _: service.judge_identity()},
        requirement_ids={case['id']: case.get('requirementIds', []) for case in authored})
