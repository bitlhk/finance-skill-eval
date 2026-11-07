import unittest

from integrations.openjiuwen.business_conversation import execute_turns
from tasks.values import fingerprint


class BusinessConversationTests(unittest.IsolatedAsyncioTestCase):
    async def test_same_agent_session_and_real_tool_offsets_per_turn(self):
        calls, observed, events, progress = [], [], [], {}
        class Agent:
            async def stream(self, value):
                observed.append(value)
                name = 'prepare' if len(observed) == 1 else 'apply'
                calls.append({'name': name, 'status': 'completed'})
                yield {'type': 'llm_output', 'payload': {'content': 'intermediate narration'}}
                yield {'type': 'answer', 'payload': {'output': 'final ' + name}}
                yield {'type': 'llm_usage', 'payload': {'usage_metadata': {'input_tokens': 10, 'output_tokens': 5}}}
        case = {'prompt': 'not a substitute for the conversation', 'turns': [{'query': 'prepare'}, {'query': 'confirm'}]}
        await execute_turns(Agent(), case, 'one-session', 'one-workspace', calls,
            lambda kind, **kwargs: events.append((kind, kwargs)), lambda value: value, progress)
        self.assertEqual([value['conversation_id'] for value in observed], ['one-session', 'one-session'])
        self.assertEqual([value['query'] for value in observed], ['prepare', 'confirm'])
        receipt = progress['conversation']
        self.assertEqual([t['toolNames'] for t in receipt['turns']], [['prepare'], ['apply']])
        self.assertEqual(receipt['turns'][1]['queryDigest'], fingerprint('confirm'))
        self.assertEqual(receipt['turns'][1]['outputDigest'], fingerprint('final apply'))
        self.assertEqual(progress['output'], 'Turn 1:\nfinal prepare\n\nTurn 2:\nfinal apply')
        self.assertEqual(progress['usage']['totalTokens'], 30)

    async def test_failure_retains_completed_turn_without_executing_later_turns(self):
        progress, queries = {}, []
        class Agent:
            async def stream(self, value):
                queries.append(value['query'])
                if len(queries) == 2:
                    raise RuntimeError('actual failure')
                yield {'type': 'answer', 'payload': {'output': 'first answer'}}
        case = {'turns': [{'query': 'one'}, {'query': 'two'}, {'query': 'three'}]}
        with self.assertRaisesRegex(RuntimeError, 'actual failure'):
            await execute_turns(Agent(), case, 'session', 'workspace', [], lambda *_args, **_kwargs: None, lambda v: v, progress)
        self.assertEqual(queries, ['one', 'two'])
        self.assertEqual(len(progress['conversation']['turns']), 1)
        self.assertEqual(progress['output'], 'Turn 1:\nfirst answer')

    def test_instance_keeps_actual_turn_inputs_and_validates_the_public_contract(self):
        from integrations.openjiuwen.test_instance_manager import request
        from integrations.openjiuwen.instance_manager import InstanceManager
        manager = InstanceManager()
        instance = manager.create(request(), 'turns')
        case = {'schemaVersion': 'finance.skill-eval.runtime-case.v1', 'caseId': 'case', 'query': 'summary',
                'turns': [{'query': 'show card', 'requiredTools': []}, {'query': 'confirm', 'requiredTools': ['apply']}]}
        actual = manager.execution(instance['instanceId'], case)
        self.assertEqual(actual['case']['turns'], case['turns'])
        self.assertEqual(actual['case']['taskMode'], 'multi_turn')
        with self.assertRaises(ValueError):
            manager.execution(instance['instanceId'], {**case, 'turns': [{'query': 'not multi-turn'}]})
