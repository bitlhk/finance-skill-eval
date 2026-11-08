import io
import json
import os
import unittest
from copy import deepcopy
from unittest.mock import patch
from tests.review_fixture import review_input


class EffectReviewAgentTest(unittest.IsolatedAsyncioTestCase):
    async def test_native_sdk_reviewer_has_independent_context_and_no_parent_tools(self):
        from agents.model_roles import execute_role
        from openjiuwen.harness.tools.subagent.task_tool import TaskTool, create_task_tool
        from openjiuwen.core.foundation.llm.schema.message import AssistantMessage
        from openjiuwen.core.foundation.llm.schema.message_chunk import AssistantMessageChunk
        answer = {'status': 'PRODUCED', 'review': {'recommendation': 'KEEP_CANDIDATE', 'reason': 'Goal met',
                  'improvements': ['Case passed'], 'regressions': [], 'evidenceIds': ['case-1']}}
        goal_answer = deepcopy(answer)
        goal_answer['review']['improvements'] = []
        requests, sessions, parents = [], [], []
        original = TaskTool.invoke
        def capture_parent(*args, **kwargs):
            parents.append(kwargs['parent_agent'])
            return create_task_tool(*args, **kwargs)
        async def delegate(tool, inputs, **kwargs):
            sessions.append((kwargs['session'].get_session_id(), inputs['subagent_type']))
            return await original(tool, inputs, **kwargs)
        async def invoke(_client, messages, **kwargs):
            requests.append((messages, kwargs))
            return AssistantMessage(content=json.dumps(goal_answer if 'goal-only-gamma' in str(messages) else answer), finish_reason='stop')
        async def stream(client, messages, **kwargs):
            response = await invoke(client, messages, **kwargs)
            yield AssistantMessageChunk(**response.model_dump())
        env = {'FINANCE_EVAL_JUDGE_PROVIDER': '', 'FINANCE_EVAL_JUDGE_MODEL': 'fixture',
               'FINANCE_EVAL_JUDGE_BASE_URL': 'http://127.0.0.1/v1', 'FINANCE_EVAL_JUDGE_API_KEY': 'fixture',
               'FINANCE_EVAL_JUDGE_REQUEST_DEFAULTS': '{}'}
        with patch.dict(os.environ, env), patch.object(TaskTool, 'invoke', delegate), \
             patch('openjiuwen.harness.tools.subagent.task_tool.create_task_tool', capture_parent), \
             patch('openjiuwen.core.foundation.llm.model_clients.openai_model_client.OpenAIModelClient.invoke', invoke), \
             patch('openjiuwen.core.foundation.llm.model_clients.openai_model_client.OpenAIModelClient.stream', stream):
            from improvement.policy import review_input as build_review_input
            goal_material = build_review_input('goal-only-gamma', None, {'candidate': {'digest': 'candidate'},
                'protocolDigest': 'protocol', 'cases': [{'id': 'case-1', 'passed': True}]}, [])
            results = [await execute_role({'role': 'effect-review', 'payload': material,
                       'model': {'providerId': 'service-judge', 'modelId': 'fixture'}, 'timeoutMs': 30000}, io.StringIO())
                       for material in (review_input('private-alpha'), review_input('private-beta'), goal_material)]
        self.assertEqual([json.loads(result['content']) for result in results], [answer, answer, goal_answer])
        self.assertEqual([item[1] for item in sessions], ['effect_reviewer'] * 3)
        self.assertNotEqual(sessions[0][0], sessions[1][0])
        self.assertTrue(all(not kwargs.get('tools') for _, kwargs in requests))
        self.assertTrue(all(not parent.deep_config.subagents for parent in parents))
        texts = [str(messages) for messages, _ in requests]
        self.assertIn('private-alpha', texts[0])
        self.assertNotIn('private-beta', texts[0])
        self.assertIn('private-beta', texts[1])
        self.assertNotIn('private-alpha', texts[1])
        self.assertIn('goal-only-gamma', texts[2])
        self.assertNotIn('baselineDigest', texts[2])
