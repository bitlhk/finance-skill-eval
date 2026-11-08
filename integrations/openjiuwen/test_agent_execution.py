import asyncio
import os
import unittest
from unittest.mock import patch, MagicMock

from .agent_execution import bind_model_deadline

from .agent_activity import stream_agent


class ModelDeadlineTests(unittest.IsolatedAsyncioTestCase):
    def test_configured_retries_are_owned_by_sdk_and_keep_the_total_deadline(self):
        from .model_config import create_model
        from types import SimpleNamespace
        model = SimpleNamespace()
        with patch.dict(os.environ, {'FINANCE_EVAL_MODEL_MAX_RETRIES': '12', 'FINANCE_EVAL_MIGRATION_REQUEST_DEFAULTS': '{}',
                                     'FINANCE_EVAL_MIGRATION_NATIVE_TOOLS': 'true'}), \
             patch('openjiuwen.core.foundation.llm.init_model', return_value=model) as init:
            self.assertIs(create_model({'apiKey': 'fixture', 'baseUrl': 'http://localhost'},
                {'model_name': 'fixture'}, role='MIGRATION', timeout_ms=300000), model)
        self.assertEqual(init.call_args.kwargs['max_retries'], 12)
        self.assertEqual(init.call_args.kwargs['timeout'], 300)
        with patch.dict(os.environ, {'FINANCE_EVAL_MODEL_MAX_RETRIES': '13'}), self.assertRaises(ValueError):
            create_model({'apiKey': 'fixture', 'baseUrl': 'http://localhost'},
                {'model_name': 'fixture'}, role='MIGRATION', timeout_ms=300000)

    async def test_invoke_and_continuously_active_stream_obey_total_deadline(self):
        class Model:
            async def invoke(self, value):
                await asyncio.sleep(1)
                return value

            async def stream(self, value):
                while True:
                    await asyncio.sleep(0.01)
                    yield value

        model = bind_model_deadline(Model(), 0.06)
        with self.assertRaises(TimeoutError):
            await model.invoke('x')
        chunks = []
        with self.assertRaises(TimeoutError):
            async for chunk in model.stream('x'):
                chunks.append(chunk)
        self.assertGreater(len(chunks), 0)

    async def test_completed_call_and_stream_keep_results(self):
        class Model:
            async def invoke(self, value):
                return value

            async def stream(self, value):
                yield value

        model = bind_model_deadline(Model(), 1)
        self.assertEqual(await model.invoke('ok'), 'ok')
        self.assertEqual([chunk async for chunk in model.stream('ok')], ['ok'])


class AgentInteractionTests(unittest.IsolatedAsyncioTestCase):
    async def test_interaction_is_preserved_even_after_model_text(self):
        class Agent:
            async def stream(self, _inputs):
                yield {'type': 'llm_output', 'payload': {'content': '需要你的选择'}}
                yield {'type': '__interaction__', 'payload': {
                    'interaction_id': 'call-1', 'questions': [{'question': '选择哪种方案？'}]}}

        class Activity:
            def delta(self, _text):
                pass

        result = await stream_agent(Agent(), {'query': '开始'}, Activity())
        self.assertEqual(result['result_type'], 'interrupt')
        self.assertEqual(result['interactions'][0]['interaction_id'], 'call-1')
        self.assertEqual(result['output'], '需要你的选择')

    async def test_empty_stream_remains_an_error(self):
        class Agent:
            async def stream(self, _inputs):
                if False:
                    yield None

        with self.assertRaisesRegex(RuntimeError, 'no answer'):
            await stream_agent(Agent(), {}, None)


class AgentAssemblyTests(unittest.TestCase):
    def test_task_session_enables_framework_context_processing_with_model_window(self):
        from .agent_execution import assemble_agent
        from openjiuwen.harness.rails.context_engineer import ContextProcessorRail

        composition = MagicMock()
        composition.definition = {'modelRole': 'MIGRATION'}
        composition.receipt.return_value = {'resources': [], 'definitionDigest': 'fixture'}
        model = MagicMock()
        model.invoke = None
        model.stream = None
        with patch('openjiuwen.core.foundation.llm.init_model', return_value=model), \
             patch('openjiuwen.harness.factory.resolve_deep_agent_parts') as factory, \
             patch('openjiuwen.agent_teams.harness.native_harness.NativeHarness', side_effect=lambda spec: spec.resolve_parts(None)), \
             patch('integrations.openjiuwen.model_config.bind_model_auth', side_effect=lambda value, _bound: value), \
             patch('integrations.openjiuwen.model_config.bind_agent_request_extensions', side_effect=lambda value, _settings, _role, *_defaults: value):
            assemble_agent(composition=composition, body={}, bound={'contextWindowTokens': 8192, 'apiKey': 'fixture', 'baseUrl': 'https://example.invalid'},
                settings={'model_name': 'fixture'}, workspace='.', operation=MagicMock(), tools=[],
                protocol=MagicMock(), trace=[], kind='deep', task_session={'skill_roots': ['trusted']})
            kwargs = factory.call_args.kwargs
            self.assertEqual(kwargs['context_engine_config'].context_window_tokens, 8192)
            self.assertTrue(kwargs['context_engine_config'].enable_reload)
            self.assertTrue(kwargs['context_engine_config'].compression_recall_config.enabled)
            rail = next(rail for rail in kwargs['rails'] if isinstance(rail, ContextProcessorRail))
            self.assertIn(('SessionMemoryCompressor', {'enabled': True}), rail._user_processors)
            self.assertEqual([item.agent_card.name for item in kwargs['subagents']],
                             ['migration_investigator', 'migration_delivery_reviewer', 'review_advisor'])
            self.assertTrue(all(not item.tools for item in kwargs['subagents']))

    def test_subagents_do_not_inherit_editing_execution_or_approval_tools(self):
        from .agent_execution import assemble_agent
        composition = MagicMock()
        composition.definition = {'modelRole': 'MIGRATION'}
        composition.receipt.return_value = {'resources': [], 'definitionDigest': 'fixture'}
        model = MagicMock(invoke=None, stream=None)
        tools = []
        for name in ('read_file', 'grep', 'write_file', 'compile_source', 'submit_result'):
            tool = MagicMock()
            tool.card.name = name
            tools.append(tool)
        evidence = MagicMock()
        evidence.card.name = 'query_development_evaluations'
        effect_request = MagicMock()
        effect_request.card.name = 'request_effect_review'
        with patch('openjiuwen.core.foundation.llm.init_model', return_value=model), \
             patch('openjiuwen.harness.factory.resolve_deep_agent_parts') as factory, \
             patch('openjiuwen.agent_teams.harness.native_harness.NativeHarness', side_effect=lambda spec: spec.resolve_parts(None)), \
             patch('integrations.openjiuwen.model_config.bind_model_auth', side_effect=lambda value, _bound: value), \
             patch('integrations.openjiuwen.model_config.bind_agent_request_extensions', side_effect=lambda value, _settings, _role, *_defaults: value):
            assemble_agent(composition=composition, body={}, bound={'apiKey': 'fixture', 'baseUrl': 'https://example.invalid'},
                settings={'model_name': 'fixture'}, workspace='.', operation=MagicMock(), tools=tools,
                protocol=MagicMock(), trace=[], kind='deep', task_session={'skill_roots': ['trusted']},
                session_tools=[evidence, effect_request])
            investigator, delivery_reviewer, reviewer = factory.call_args.kwargs['subagents']
            self.assertEqual([tool.card.name for tool in investigator.tools], ['read_file', 'grep'])
            self.assertEqual([tool.card.name for tool in delivery_reviewer.tools], ['read_file', 'grep', 'query_development_evaluations'])
            self.assertEqual(reviewer.tools, [])
