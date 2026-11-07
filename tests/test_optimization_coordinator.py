import unittest
import asyncio
from types import SimpleNamespace
import io
import json
import os
from unittest.mock import AsyncMock, patch

from integrations.openjiuwen.optimization_coordinator import OptimizationCoordinator


def evaluation(identity, results):
    return {'id': identity, 'candidate': {'id': identity, 'digest': identity}, 'protocolDigest': 'p',
            'cases': [{'id': str(index), 'passed': passed, 'observation': {}} for index, passed in enumerate(results)]}


class CoordinatorTests(unittest.IsolatedAsyncioTestCase):
    async def test_retrying_failed_diagnosis_keeps_the_same_experiment_budget(self):
        baseline = evaluation('old', [False])
        state = {'goal': {'maxRounds': 1, 'targetPassRate': 1}, 'baseline': baseline['candidate'],
                 'best': baseline['candidate'], 'bestEvaluationId': 'old', 'status': 'RUNNING',
                 'stage': 'DIAGNOSIS', 'rounds': []}
        attempts = 0
        async def invoke(name, payload):
            nonlocal attempts
            if name == 'diagnose':
                attempts += 1
                if attempts == 1:
                    raise RuntimeError('Transient model failure')
                return {'value': {'status': 'PROPOSED', 'hypothesis': {'issue': 'real defect'}}}
            return {'value': None}
        agent = OptimizationCoordinator(state, baseline, invoke)
        await agent.initialize()
        with self.assertRaisesRegex(RuntimeError, 'Transient'):
            await agent.diagnose()
        self.assertTrue((await agent.diagnose())['accepted'])
        self.assertEqual(len(state['rounds']), 1)
        self.assertEqual(state['rounds'][0]['number'], 1)
        self.assertEqual(agent.phase, 'ADJUSTMENT')

    async def test_input_wait_resumes_same_adjustment_before_evaluation(self):
        baseline, candidate = evaluation('old', [False]), evaluation('new', [True])
        state = {'goal': {'maxRounds': 1, 'targetPassRate': 1}, 'baseline': baseline['candidate'],
                 'best': baseline['candidate'], 'bestEvaluationId': 'old', 'status': 'RUNNING',
                 'stage': 'DIAGNOSIS', 'rounds': []}
        calls = []
        async def invoke(name, payload):
            calls.append(name)
            values = {'diagnose': {'status': 'PROPOSED', 'hypothesis': {'issue': 'needs input'}},
                      'adjust': ({'status': 'WAITING', 'kind': 'INPUT', 'candidate': baseline['candidate'],
                                  'reason': '请补充要求'} if calls.count('adjust') == 1 else candidate['candidate']),
                      'evaluate': candidate,
                      'review': {'status': 'PRODUCED', 'review': {'recommendation': 'KEEP_CANDIDATE',
                          'reason': 'ok', 'evidenceIds': ['0'], 'regressions': []}}}
            return {'value': values.get(name)}
        agent = OptimizationCoordinator(state, baseline, invoke)
        await agent.initialize()
        await agent.diagnose()
        self.assertEqual((await agent.adjust())['status'], 'WAITING')
        self.assertEqual(state['status'], 'WAITING')
        resumed = OptimizationCoordinator(state, baseline, invoke,
            {'phase': 'ADJUSTMENT', 'working': baseline, 'incumbent': baseline})
        await resumed.initialize()
        self.assertEqual(state['status'], 'RUNNING')
        self.assertEqual(resumed.phase, 'ADJUSTMENT')
        self.assertTrue((await resumed.adjust())['accepted'])
        self.assertTrue((await resumed.evaluate())['accepted'])
        await resumed.review()
        self.assertEqual(state['status'], 'REVIEW')
        self.assertEqual(len(state['rounds']), 1)
        self.assertEqual(calls.count('diagnose'), 1)
        self.assertEqual(calls.count('adjust'), 2)

    async def test_input_resume_rejects_other_wait_or_working_version(self):
        baseline = evaluation('old', [False])
        for kind, waiting_candidate in [('BUILDER', baseline['candidate']), ('INPUT', {'id': 'other', 'digest': 'other'})]:
            with self.subTest(kind=kind, candidate=waiting_candidate):
                state = {'goal': {'maxRounds': 1}, 'rounds': [{'stage': 'ADJUSTMENT', 'diagnosis': {'status': 'PROPOSED'}}],
                         'waiting': {'kind': kind, 'candidate': waiting_candidate}}
                agent = OptimizationCoordinator(state, baseline, AsyncMock(),
                    {'phase': 'ADJUSTMENT', 'working': baseline, 'incumbent': baseline})
                with self.assertRaises(ValueError):
                    await agent.initialize()

    async def test_builder_tool_requires_matching_delivery_before_evaluation(self):
        baseline, candidate = evaluation('old', [False]), evaluation('new', [True])
        state = {'goal': {'maxRounds': 1, 'targetPassRate': 1}, 'baseline': baseline['candidate'],
                 'best': baseline['candidate'], 'bestEvaluationId': 'old', 'status': 'RUNNING', 'stage': 'DIAGNOSIS',
                 'rounds': [], 'deadlineAt': '2099-01-01T00:00:00Z'}
        calls = []
        async def invoke(name, payload):
            calls.append(name)
            values = {'diagnose': {'status': 'PROPOSED', 'hypothesis': {'issue': 'runtime'}},
                      'adjust': {'status': 'WAITING', 'kind': 'BUILDER', 'candidate': candidate['candidate'], 'reason': 'runtime'},
                      'build_runtime': {'status': 'READY', 'candidate': candidate['candidate'], 'reference': 'binding-1'},
                      'evaluate': candidate}
            return {'value': values.get(name)}
        agent = OptimizationCoordinator(state, baseline, invoke, build_available=True)
        await agent.initialize()
        await agent.diagnose()
        self.assertEqual((await agent.adjust())['status'], 'BUILDER_REQUIRED')
        self.assertFalse((await agent.evaluate())['accepted'])
        self.assertTrue((await agent.build_runtime())['accepted'])
        self.assertTrue((await agent.evaluate())['accepted'])
        self.assertLess(calls.index('build_runtime'), calls.index('evaluate'))

    async def test_only_recovers_an_explicit_unambiguous_argument_free_tool(self):
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations' / 'openjiuwen'))
        self.addCleanup(sys.path.pop, 0)
        from optimization_agent import recover_explicit_tool
        response = SimpleNamespace(finish_reason='length', tool_calls=None,
                                   content='正在审查\n<tool_call>\n<function=review_candidate>\n   ')
        self.assertEqual(recover_explicit_tool(response), 'review_candidate')
        response.content += '<tool_call><function=adjust_candidate>'
        self.assertIsNone(recover_explicit_tool(response))
        response.content = '<tool_call><function=finish_optimization>'
        self.assertIsNone(recover_explicit_tool(response))
        response.content = '<tool_call><function=review_candidate>'
        response.finish_reason = 'stop'
        self.assertIsNone(recover_explicit_tool(response))

    async def test_sdk_agent_can_select_builder_tool_and_continue(self):
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations' / 'openjiuwen'))
        self.addCleanup(sys.path.pop, 0)
        import optimization_agent
        baseline, candidate = evaluation('old', [False]), evaluation('new', [True])
        state = {'id': 'loop', 'goal': {'goal': '修复', 'maxRounds': 1, 'targetPassRate': 1},
                 'baseline': baseline['candidate'], 'best': baseline['candidate'], 'bestEvaluationId': 'old',
                 'status': 'RUNNING', 'stage': 'DIAGNOSIS', 'rounds': [], 'deadlineAt': '2099-01-01T00:00:00Z'}
        actions = iter(['diagnose_optimization', 'adjust_candidate', 'build_runtime', 'evaluate_candidate', 'review_candidate'])
        calls = []
        class Bridge:
            def __init__(self, output): pass
            async def invoke(self, name, payload):
                calls.append(name)
                values = {'model': lambda: json.dumps({'tool': next(actions), 'arguments': {}}),
                          'diagnose': lambda: {'status': 'PROPOSED', 'hypothesis': {'issue': 'runtime'}},
                          'adjust': lambda: {'status': 'WAITING', 'kind': 'BUILDER', 'candidate': candidate['candidate'], 'reason': 'runtime'},
                          'build_runtime': lambda: {'status': 'READY', 'candidate': candidate['candidate'], 'reference': 'binding'},
                          'evaluate': lambda: candidate,
                          'review': lambda: {'status': 'PRODUCED', 'review': {'recommendation': 'KEEP_CANDIDATE', 'reason': 'ok', 'evidenceIds': ['0'], 'regressions': []}}}
                return {'value': values[name]() if name in values else None}
        async def native_complete(_adapter, request):
            return {'content': (await Bridge(None).invoke('model', {'messages': request['messages']}))['value'], 'modelId': 'fixture'}
        with patch.dict(os.environ, {'FINANCE_EVAL_OPTIMIZER_PROVIDER': 'codex_cli'}, clear=False), \
                patch('runtime.models.shutil.which', return_value='fixture'), patch('runtime.models.CodexCLIModel.complete', native_complete):
            await optimization_agent.run({'state': state, 'baseline': baseline, 'buildAvailable': True}, io.StringIO(), invoke=Bridge(None).invoke)
        self.assertEqual(state['status'], 'REVIEW', state.get('reason'))
        self.assertLess(calls.index('build_runtime'), calls.index('evaluate'))

    async def test_sdk_coordinator_uses_text_adapter_and_registered_tools(self):
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations' / 'openjiuwen'))
        self.addCleanup(sys.path.pop, 0)
        import optimization_agent
        baseline, candidate = evaluation('old', [False]), evaluation('new', [True])
        baseline['cases'][0]['observation'] = 'PRIVATE_EVIDENCE_MARKER'
        candidate['cases'][0]['observation'] = 'PRIVATE_CANDIDATE_MARKER'
        state = {'id': 'loop', 'goal': {'goal': '修复问题', 'maxRounds': 1, 'targetPassRate': 1},
                 'baseline': baseline['candidate'], 'best': baseline['candidate'], 'bestEvaluationId': 'old',
                 'status': 'RUNNING', 'stage': 'DIAGNOSIS', 'rounds': [], 'deadlineAt': '2099-01-01T00:00:00Z'}
        actions = iter(['diagnose_optimization', 'adjust_candidate', 'evaluate_candidate', 'review_candidate'])
        calls = []
        class Bridge:
            def __init__(self, output): pass
            async def invoke(self, name, payload):
                calls.append(name)
                if name == 'evaluate':
                    await asyncio.sleep(.05)
                if name == 'model':
                    serialized = json.dumps(payload, ensure_ascii=False)
                    if 'PRIVATE_EVIDENCE_MARKER' in serialized or 'PRIVATE_CANDIDATE_MARKER' in serialized:
                        raise AssertionError('Raw evidence reached the coordinator')
                values = {'model': lambda: json.dumps({'tool': next(actions), 'arguments': {}}),
                          'diagnose': lambda: {'status': 'PROPOSED', 'hypothesis': {'issue': '缺陷'}},
                          'adjust': lambda: candidate['candidate'], 'evaluate': lambda: candidate,
                          'review': lambda: {'status': 'PRODUCED', 'review': {'recommendation': 'KEEP_CANDIDATE',
                              'reason': '效果改善', 'evidenceIds': ['0'], 'regressions': []}}}
                return {'value': values[name]() if name in values else None}
        async def native_complete(_adapter, request):
            return {'content': (await Bridge(None).invoke('model', {'messages': request['messages']}))['value'], 'modelId': 'fixture'}
        with patch.dict(os.environ, {'FINANCE_EVAL_OPTIMIZER_PROVIDER': 'codex_cli'}, clear=False), \
                patch('runtime.models.shutil.which', return_value='fixture'), \
                patch('openjiuwen.core.single_agent.ability_manager.DEFAULT_TOOL_CALL_TIMEOUT', .01), \
                patch('runtime.models.CodexCLIModel.complete', native_complete):
            output = io.StringIO()
            await optimization_agent.run({'state': state, 'baseline': baseline}, output, invoke=Bridge(output).invoke)
        self.assertEqual(state['status'], 'REVIEW', state.get('reason'))
        self.assertEqual(state['best']['id'], 'new')
        self.assertTrue({'diagnose', 'adjust', 'evaluate', 'review'} <= set(calls))
        self.assertEqual(state['coordinatorComposition']['role'], 'optimization-coordinator')

    async def test_text_model_adapter_emits_sdk_tool_call_without_executing_it(self):
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations' / 'openjiuwen'))
        self.addCleanup(sys.path.pop, 0)
        from integrations.openjiuwen.model_tool_protocol import bind_text_tools
        from openjiuwen.core.foundation.llm.schema.message import AssistantMessage
        received = []
        async def complete(messages, **kwargs):
            received.append(kwargs)
            return AssistantMessage(content='{"tool":"diagnose_optimization","arguments":{}}')
        model = bind_text_tools(SimpleNamespace(invoke=complete))
        response = await model.invoke([{'role': 'user', 'content': '优化'}], tools=[{'name': 'diagnose_optimization'}])
        self.assertNotIn('tools', received[0])
        self.assertEqual(response.tool_calls[0].name, 'diagnose_optimization')
        chunks = [item async for item in model.stream([{'role': 'user', 'content': '优化'}], tools=[{'name': 'diagnose_optimization'}])]
        self.assertEqual(chunks[0].tool_calls[0].name, 'diagnose_optimization')

    async def test_review_controls_adoption_and_agent_can_continue(self):
        baseline, candidate = evaluation('old', [True, False]), evaluation('new', [False, True])
        state = {'id': 'loop', 'goal': {'maxRounds': 2, 'targetPassRate': 1}, 'baseline': baseline['candidate'],
                 'best': baseline['candidate'], 'bestEvaluationId': 'old', 'status': 'RUNNING', 'stage': 'DIAGNOSIS',
                 'rounds': [], 'deadlineAt': '2099-01-01T00:00:00Z'}
        calls = []
        async def invoke(name, payload):
            calls.append((name, payload))
            if name == 'diagnose': return {'value': {'status': 'PROPOSED', 'hypothesis': {'issue': 'missing'}}}
            if name == 'adjust': return {'value': candidate['candidate']}
            if name == 'evaluate': return {'value': candidate}
            if name == 'review': return {'value': {'status': 'PRODUCED', 'review': {'recommendation': 'CONTINUE_CANDIDATE',
                'reason': 'Keep fixing', 'evidenceIds': ['0'], 'regressions': ['0'], 'tradeoff': 'priority', 'nextFocus': ['repair']}}}
            return {'value': None}
        agent = OptimizationCoordinator(state, baseline, invoke)
        await agent.initialize()
        self.assertFalse((await agent.evaluate())['accepted'])
        await agent.diagnose()
        await agent.adjust()
        await agent.evaluate()
        result = await agent.review()
        self.assertTrue(result['decision']['continued'])
        self.assertEqual(state['best']['id'], 'old')
        self.assertEqual(state['working']['id'], 'new')
        await agent.finish('暂停继续修复')
        self.assertEqual(state['best']['id'], 'old')
        self.assertEqual([name for name, _ in calls if name == 'review'], ['review'])

    async def test_unrelated_candidate_cannot_be_reviewed(self):
        baseline, candidate = evaluation('old', [True]), evaluation('new', [True])
        state = {'goal': {'maxRounds': 1, 'targetPassRate': 1}, 'baseline': baseline['candidate'],
                 'best': baseline['candidate'], 'bestEvaluationId': 'old', 'status': 'RUNNING', 'stage': 'DIAGNOSIS',
                 'rounds': [], 'deadlineAt': '2099-01-01T00:00:00Z'}
        async def invoke(name, payload):
            values = {'diagnose': {'status': 'PROPOSED'}, 'adjust': candidate['candidate'], 'evaluate': baseline}
            return {'value': values.get(name)}
        agent = OptimizationCoordinator(state, baseline, invoke)
        await agent.initialize()
        await agent.diagnose()
        await agent.adjust()
        with self.assertRaisesRegex(ValueError, '不属于本轮'):
            await agent.evaluate()
