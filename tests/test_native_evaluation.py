import asyncio
import unittest

from evaluation.comparison import evaluate, evaluate_suite
from evaluation.orchestration import evaluate_methods, planned_methods


def evidence(output='ok', status='completed'):
    return {'status': status, 'output': output, 'toolCalls': [], 'metadata': {},
            'elapsedMs': 1, 'runtimeIdentityVerified': True, 'streamCompleted': True}


class NativeEvaluationTests(unittest.IsolatedAsyncioTestCase):
    async def test_failed_execution_does_not_spend_model_calls_on_process_judging(self):
        from evaluation.scoring import evaluate_comparison
        from unittest.mock import AsyncMock, patch
        from types import SimpleNamespace
        case = {'caseId': 'failed', 'name': 'failed', 'prompt': 'task', 'evaluationGoal': 'goal',
            'rubric': [{'criterionId': 'execute', 'scope': 'execution'}]}
        judge = SimpleNamespace(independent=False, mode='pairwise', judge_id='controlled', model={}, compare=AsyncMock())
        agent = AsyncMock(side_effect=AssertionError('Incomplete execution must not invoke a process Judge'))
        with patch('evaluation.scoring.judge_criteria', agent):
            result = await evaluate_comparison(case, evidence(status='failed'), evidence(status='failed'), judge, {})
        agent.assert_not_awaited()
        judge.compare.assert_not_awaited()
        self.assertTrue(result['judgeError'])
        self.assertEqual(result['methodResults']['right'][0]['checks'][0]['status'], 'UNVERIFIED')

    async def test_suite_cleanup_precedes_judging_and_finalization_survives_failure(self):
        seen = []
        pack = {'cases': [{'caseId': 'one'}, {'caseId': 'two'}]}
        def handler(name, result=None):
            def invoke(inputs):
                seen.append(name)
                return result
            return invoke
        handlers = {name: handler(name) for name in ('progress', 'prepare', 'cleanup', 'finalization')}
        handlers['execute_cases'] = handler('execute', {case['caseId']: {'left': evidence(), 'right': evidence()}
                                                       for case in pack['cases']})
        handlers['evaluate_case'] = handler('judge', {'judge': {'winner': 'right'}})
        handlers['report'] = lambda inputs: inputs
        result = await evaluate_suite(pack, handlers, run_id='run')
        self.assertEqual(len(result['cases']), 2)
        self.assertEqual(result['reportId'], 'run')
        self.assertEqual(seen.count('cleanup'), 1)
        self.assertLess(seen.index('cleanup'), seen.index('judge'))
        self.assertEqual(seen[-1], 'finalization')
        # Missing one side cannot be hidden by a successful judge/report.
        seen.clear()
        handlers['execute_cases'] = handler('execute', {'one': {'left': evidence()}})
        with self.assertRaisesRegex(ValueError, 'both sides'):
            await evaluate_suite(pack, handlers)
        self.assertNotIn('judge', seen)
        self.assertEqual(seen.count('cleanup'), 1)
        self.assertEqual(seen[-1], 'finalization')

    async def test_suite_prepare_failure_and_cleanup_failure_both_keep_final_receipt(self):
        for phase in ('prepare', 'cleanup'):
            with self.subTest(phase=phase):
                seen = []
                def invoke(name):
                    def handler(inputs):
                        seen.append(name)
                        if name == phase:
                            raise ValueError('failed ' + phase)
                        return {}
                    return handler
                handlers = {name: invoke(name) for name in ('progress', 'prepare', 'execute_cases', 'cleanup', 'finalization')}
                with self.assertRaisesRegex(Exception, 'failed ' + phase):
                    await evaluate_suite({'cases': []}, handlers)
                self.assertEqual(seen.count('cleanup'), 1)
                self.assertEqual(seen[-1], 'finalization')

    async def test_cancelled_suite_releases_runtime_and_keeps_receipt_without_judging(self):
        started, seen = asyncio.Event(), []
        async def execute(_):
            started.set()
            await asyncio.Event().wait()
        def record(name):
            def invoke(_):
                seen.append(name)
            return invoke
        handlers = {name: record(name) for name in ('progress', 'prepare', 'cleanup', 'finalization', 'evaluate_case', 'report')}
        handlers['execute_cases'] = execute
        task = asyncio.create_task(evaluate_suite({'cases': [{'caseId': 'one'}]}, handlers))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(seen[-2:], ['cleanup', 'finalization'])
        self.assertNotIn('evaluate_case', seen)
        self.assertNotIn('report', seen)

    async def test_both_sides_use_existing_rules_and_one_comparison_judge(self):
        case = {'caseId': 'one', 'name': 'one', 'prompt': 'query', 'evaluationGoal': 'goal',
                'evaluationPlan': {'checks': [{'id': 'answer', 'version': '1', 'kind': 'RULE',
                    'rule': {'operation': 'equals', 'reference': '/output', 'expected': 'ok'}}]}}
        seen = []
        async def judge(inputs):
            seen.append(inputs)
            return {'winner': 'left'}
        result = await evaluate(case, evidence(), evidence('wrong'), judge)
        self.assertEqual(result['methodResults']['left'][0]['status'], 'PASS')
        self.assertEqual(result['methodResults']['right'][0]['status'], 'FAIL')
        self.assertEqual(result['judge'], {'winner': 'left'})
        self.assertEqual(len(seen), 1)
        self.assertEqual(result['answerEvidence']['left']['materials']['output'], 'ok')

    async def test_failed_execution_does_not_trigger_pairwise_judge(self):
        async def forbidden(_):
            self.fail('A failed execution must not be judged as professional quality')
        case = {'caseId': 'one', 'name': 'one', 'prompt': 'query', 'evaluationGoal': 'goal'}
        result = await evaluate(case, evidence(status='failed'), evidence(), forbidden)
        self.assertIsNone(result['judge'])
        self.assertTrue(result['judgeError'])

    async def test_dependency_failures_skip_model_and_each_method_gets_a_frozen_copy(self):
        received = []
        async def first(inputs):
            inputs['evidence']['output'] = 'mutated'
            return [{'id': 'one', 'status': 'FAIL'}]
        async def second(inputs):
            received.append(inputs['evidence']['output'])
            return [{'id': 'two', 'status': 'PASS'}]
        methods = [{'id': 'first', 'version': '1', 'kind': 'RULE', 'evaluate': first},
                   {'id': 'blocked', 'version': '1', 'kind': 'MODEL', 'dependsOn': ['first'], 'evaluate': second},
                   {'id': 'independent', 'version': '1', 'kind': 'AGENT', 'evaluate': second}]
        original = evidence()
        results = await evaluate_methods({}, original, methods)
        self.assertEqual([r['status'] for r in results], ['FAIL', 'SKIP', 'PASS'])
        self.assertEqual(received, ['ok'])
        self.assertEqual(original['output'], 'ok')

    async def test_scripts_use_injected_executor_and_validate_citations(self):
        executed = []
        async def script_executor(script, material, timeout):
            executed.append((script, material['output'], timeout))
            return {'checks': [{'id': 'script', 'status': 'PASS', 'reason': 'checked', 'evidenceRefs': []}]}
        plan = {'checks': [{'id': 'script', 'version': '1', 'kind': 'SCRIPT',
                            'script': 'verify', 'timeoutMs': 1000, 'evidenceRefs': ['/output']}]}
        results = await evaluate_methods({}, evidence(), planned_methods(plan, script_executor))
        self.assertEqual(results[0]['status'], 'UNVERIFIED')
        self.assertEqual(executed, [('verify', 'ok', 1000)])

    async def test_timeout_is_an_error_but_cancellation_propagates(self):
        started, stopped = asyncio.Event(), asyncio.Event()
        async def wait(_):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        method = {'id': 'wait', 'version': '1', 'kind': 'MODEL', 'timeoutMs': 10, 'evaluate': wait}
        results = await evaluate_methods({}, evidence(), [method])
        self.assertEqual(results[0]['status'], 'ERROR')
        self.assertTrue(stopped.is_set())
        started.clear()
        task = asyncio.create_task(evaluate_methods({}, evidence(), [{**method, 'timeoutMs': 10000}]))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
