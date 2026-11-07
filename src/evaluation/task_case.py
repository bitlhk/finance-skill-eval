"""The same frozen-case rule/model/script pipeline for live runs and rescoring."""
from agents.criterion import judge_criteria, judge_identity
from evaluation.checks import execution_checks
from evaluation.orchestration import evaluate_methods, planned_methods
from evaluation.scripts import verify_script
from evaluation.verdict import task_verdict
from runtime.models import ModelCompletionError, model_timeout_ms


async def assess_task_case(eval_case, evidence, *, expected=None, requirements=(), tools=None, judge=judge_criteria, on_composition=None, execution_checks_override=None):
    checks = execution_checks(evidence, expected) if execution_checks_override is None else execution_checks_override
    verdict = {'passed': False, 'unverified': True, 'reason': '执行未完成，或整组装载证据不完整'}
    async def execution(_inputs):
        return checks
    async def business(inputs):
        nonlocal verdict
        values = {'evalCase': inputs['evalCase'], 'evidence': inputs['evidence'], 'requirements': list(requirements), 'tools': tools}
        try:
            verdict = await judge(values, on_composition=on_composition)
        except ModelCompletionError as error:
            if error.code != 'MODEL_NETWORK_ERROR':
                raise
            verdict = await judge(values, on_composition=on_composition)
        return [{'id': item['id'], 'status': 'UNVERIFIED' if item['passed'] is None else 'PASS' if item['passed'] else 'FAIL',
                 'reason': item['reason'], 'evidenceRefs': item['evidenceRefs']} for item in verdict['criteria']] if verdict.get('criteria') is not None else [
                 {'id': 'business', 'status': 'UNVERIFIED' if verdict.get('unverified') else 'PASS' if verdict['passed'] else 'FAIL', 'reason': verdict['reason']}]
    methods = [{'id': 'bundle-execution', 'version': '1', 'kind': 'RULE', 'evaluate': execution},
        {'id': 'business-judge', 'version': judge_identity(), 'kind': 'MODEL', 'dependsOn': ['bundle-execution'],
         'timeoutMs': model_timeout_ms('JUDGE'), 'evaluate': business}, *planned_methods(eval_case.get('evaluationPlan'), verify_script)]
    results = await evaluate_methods(eval_case, evidence, methods)
    return {**task_verdict(results, verdict, eval_case.get('evaluationPlan')), 'executionChecks': checks}
