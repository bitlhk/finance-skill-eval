import tempfile
import asyncio
import unittest
import json
import io
from unittest.mock import AsyncMock, patch
from pathlib import Path

from openjiuwen.core.session.agent import create_agent_session
from openjiuwen.core.session.checkpointer import CheckpointerFactory

from .agent_session import (TaskAgentSession, install_task_checkpointer, task_agent_card,
                            task_session_identity)
from .agent_conversation_store import ConversationStore, InteractionConflict


class TaskSessionPersistenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_cold_recovery_uses_durable_query_and_warns_about_unconfirmed_effects(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        class Agent:
            def __init__(self): self.sent=[]
            def outputs(self):
                async def chunks():
                    yield {'type':'answer','payload':{'output':'recovered'}}
                    yield {'type':'platform_round_end','payload':{'roundId':1,'kind':'finished'}}
                return chunks()
            async def send(self, query): self.sent.append(query)
        with tempfile.TemporaryDirectory() as root:
            store=ConversationStore(root);await store.initialize()
            await store.save_recovery_round('session','attempt','继续迁移原工程')
            await store.append('session','tool-start','tool_boundary',{
                'attemptId':'attempt','callId':'call-1','name':'run_project_command','status':'started'})
            agent=Agent();activity=SimpleNamespace(send=lambda *_args:None)
            session=TaskAgentSession(agent,'session',activity,store,'attempt')
            session._started=True;session._sdk_session=SimpleNamespace(commit=AsyncMock())
            result=await session.run('',recover_checkpoint=True)
            self.assertEqual(result['output'],'recovered')
            self.assertIn('继续迁移原工程',agent.sent[0])
            self.assertIn('call-1',agent.sent[0]);self.assertIn('禁止盲目重试',agent.sent[0])
            self.assertEqual((await store.recovery_round('session','attempt'))['status'],'finished')
            self.assertIsNone(await store.recovery_round('another','attempt'))

    async def test_checkpoint_failure_cannot_publish_a_recoverable_round(self):
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        with tempfile.TemporaryDirectory() as root:
            store=ConversationStore(root);await store.initialize()
            session=TaskAgentSession(SimpleNamespace(),'session',None,store,'attempt')
            session._started=True
            session._sdk_session=SimpleNamespace(commit=AsyncMock(side_effect=OSError('disk full')))
            with self.assertRaisesRegex(OSError,'disk full'):
                await session.run('work')
            self.assertIsNone(await store.recovery_round('session','attempt'))

    async def test_failed_round_surfaces_only_the_safe_model_diagnosis(self):
        from types import SimpleNamespace
        class Agent:
            def outputs(self):
                async def chunks():
                    yield {'type':'platform_round_end','payload':{'roundId':1,'kind':'failed'}}
                return chunks()
            async def send(self, _query): pass
        session=TaskAgentSession(Agent(),'session',SimpleNamespace(last_model_error='模型请求失败（HTTP 429），请检查服务限流或配额后重试'))
        session._started=True
        with self.assertRaisesRegex(RuntimeError, 'HTTP 429'):
            await session.run('work')

    async def test_cold_resume_does_not_acknowledge_framework_noop(self):
        class Agent:
            def outputs(self):
                async def chunks():
                    if False:
                        yield None
                return chunks()
            async def resume(self, *, query):
                pass  # NativeHarness permits a no-op outside a resumable state.

        with tempfile.TemporaryDirectory() as root:
            store = ConversationStore(Path(root) / 'conversations.db')
            await store.initialize()
            await store.save_paused_round('session', 'attempt', 'pause', 'original query')
            session = TaskAgentSession(Agent(), 'session', None, store, 'attempt')
            session._started = True
            with self.assertRaisesRegex(RuntimeError, '未确认继续'):
                await session.run('', resume_paused=True)
            record = await store.paused_round('session', 'attempt')
            self.assertEqual(record['status'], 'resuming')

    async def test_warm_resume_does_not_acknowledge_framework_noop(self):
        from openjiuwen.agent_teams.harness.state import HarnessState
        class Agent:
            state = HarnessState.PAUSED
            async def resume(self):
                pass

        with tempfile.TemporaryDirectory() as root:
            store = ConversationStore(root)
            await store.initialize()
            await store.save_paused_round('session', 'attempt', 'pause', 'original query')
            session = TaskAgentSession(Agent(), 'session', None, store, 'attempt')
            session._started = True
            session._pause_id = 'pause'
            self.assertFalse(await session.resume())
            self.assertEqual((await store.paused_round('session', 'attempt'))['status'], 'resuming')

    async def test_cancel_does_not_acknowledge_before_checkpoint_is_saved(self):
        committing = asyncio.Event()
        release = asyncio.Event()

        class Agent:
            from openjiuwen.agent_teams.harness.state import HarnessState
            state = HarnessState.RUNNING
            def outputs(self):
                async def chunks():
                    yield {'type':'answer','payload':{'output':'done'}}
                    yield {'type':'platform_round_end','payload':{'roundId':1,'kind':'finished'}}
                return chunks()
            async def send(self, _query): pass
            async def abort(self, *, immediate): pass

        class FrameworkSession:
            async def commit(self):
                committing.set()
                await release.wait()

        session = TaskAgentSession(Agent(), 'session', None)
        session._started = True
        session._sdk_session = FrameworkSession()
        running = asyncio.create_task(session.run('work'))
        await asyncio.wait_for(committing.wait(), 1)
        cancellation = asyncio.create_task(session.cancel())
        await asyncio.sleep(0.05)
        self.assertFalse(cancellation.done())
        release.set()
        self.assertEqual((await asyncio.wait_for(running, 1))['output'], 'done')
        self.assertTrue(await asyncio.wait_for(cancellation, 1))

    async def test_cancel_confirms_stop_but_checkpoint_error_is_preserved(self):
        committing = asyncio.Event()
        release = asyncio.Event()

        class Agent:
            from openjiuwen.agent_teams.harness.state import HarnessState
            state = HarnessState.RUNNING
            def outputs(self):
                async def chunks():
                    yield {'type':'answer','payload':{'output':'done'}}
                    yield {'type':'platform_round_end','payload':{'roundId':1,'kind':'finished'}}
                return chunks()
            async def send(self, _query): pass
            async def abort(self, *, immediate): pass

        class FrameworkSession:
            async def commit(self):
                committing.set()
                await release.wait()
                raise OSError('checkpoint unavailable')

        session = TaskAgentSession(Agent(), 'session', None)
        session._started = True
        session._sdk_session = FrameworkSession()
        running = asyncio.create_task(session.run('work'))
        await asyncio.wait_for(committing.wait(), 1)
        cancellation = asyncio.create_task(session.cancel())
        release.set()
        with self.assertRaisesRegex(OSError, 'checkpoint unavailable'):
            await asyncio.wait_for(running, 1)
        self.assertTrue(await asyncio.wait_for(cancellation, 1))

    async def test_cancel_waits_until_output_consumer_finishes(self):
        requested = asyncio.Event()

        class Agent:
            from openjiuwen.agent_teams.harness.state import HarnessState
            state = HarnessState.RUNNING
            async def abort(self, *, immediate):
                requested.set()

        agent = Agent()
        session = TaskAgentSession(agent, 'session', None)
        session._started = True
        session._round_ready.set()
        cancellation = asyncio.create_task(session.cancel())
        await asyncio.wait_for(requested.wait(), 1)
        self.assertFalse(cancellation.done())
        session._round_ready.clear()
        self.assertTrue(await asyncio.wait_for(cancellation, 1))

    async def test_cancel_paused_round_releases_the_existing_output_consumer(self):
        from openjiuwen.agent_teams.harness.state import HarnessState
        queue = asyncio.Queue()
        class Agent:
            state = HarnessState.PAUSED
            def outputs(self):
                async def chunks():
                    yield await queue.get()
                return chunks()
            async def send(self, _query): pass
            async def abort(self, *, immediate): self.state = HarnessState.IDLE
        class FrameworkSession:
            async def write_stream(self, value): await queue.put(value)
        session = TaskAgentSession(Agent(), 'session', None)
        session._started = True;session._sdk_session = FrameworkSession()
        running=asyncio.create_task(session.run('work'))
        await asyncio.wait_for(session._round_ready.wait(),1)
        self.assertTrue(await asyncio.wait_for(session.cancel(),1))
        with self.assertRaisesRegex(RuntimeError,'中止或失败'):
            await asyncio.wait_for(running,1)

    async def test_framework_checkpoint_recovers_and_isolates_tasks(self):
        previous = CheckpointerFactory._default_checkpointer
        checkpointers = []
        try:
            with tempfile.TemporaryDirectory() as root:
                checkpointers.append(await install_task_checkpointer(root))
                first_id = task_session_identity('workspace-a', 'task-1')
                session = create_agent_session(session_id=first_id, card=task_agent_card())
                await session.pre_run(inputs=None)
                session.update_state({'user_decision': 'preserve the original service'})
                await session.commit()

                # Construct a fresh SDK checkpointer/session, as on host restart.
                await checkpointers[-1]._kv_store.engine.dispose()
                checkpointers.append(await install_task_checkpointer(root))
                restored = create_agent_session(session_id=first_id, card=task_agent_card())
                await restored.pre_run(inputs=None)
                self.assertEqual(restored.get_state('user_decision'), 'preserve the original service')

                other = create_agent_session(
                    session_id=task_session_identity('workspace-a', 'task-2'), card=task_agent_card())
                await other.pre_run(inputs=None)
                self.assertIsNone(other.get_state('user_decision'))
                await checkpointers[-1]._kv_store.engine.dispose()
        finally:
            CheckpointerFactory.set_default_checkpointer(previous)

    def test_identity_binds_workspace_and_task_without_ambiguous_delimiters(self):
        self.assertNotEqual(task_session_identity('a', 'b:c'), task_session_identity('a:b', 'c'))
        self.assertNotEqual(task_session_identity('a', 'task'), task_session_identity('b', 'task'))
        with self.assertRaises(ValueError):
            task_session_identity('', 'task')

    async def test_native_ask_user_interrupt_and_resume_after_agent_recreation(self):
        import httpx
        from openai import AsyncOpenAI
        from .agent_execution import assemble_agent

        previous = CheckpointerFactory._default_checkpointer
        calls = []

        def respond(request):
            request_body = json.loads(request.content)
            calls.append(request_body)
            if len(calls) == 1:
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'question-1', 'type': 'function',
                    'function': {'name': 'ask_user', 'arguments': json.dumps({'questions': [{
                        'header': '范围', 'question': '选择哪种方案？',
                        'options': [{'label': '原有服务', 'description': '保留现有服务'}]}]}, ensure_ascii=False)}}]}
                finish = 'tool_calls'
            else:
                delta = {'role': 'assistant', 'content': '已记录，继续迁移。'}
                finish = 'stop'
            chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'fixture',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            if not request_body.get('stream'):
                return httpx.Response(200, json={'id': 'fixture', 'object': 'chat.completion', 'created': 0,
                    'model': 'fixture', 'choices': [{'index': 0, 'message': delta, 'finish_reason': finish}]})
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                  text='data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\ndata: [DONE]\n\n')

        with tempfile.TemporaryDirectory() as root:
            checkpointer = await install_task_checkpointer(root)
            try:
                store = ConversationStore(root)
                await store.initialize()
                skill_dir = Path(root) / 'skills' / 'sample'
                skill_dir.mkdir(parents=True)
                (skill_dir / 'SKILL.md').write_text('---\nname: sample\ndescription: 示例指导\n---\n按需执行。\n', encoding='utf-8')
                async with AsyncOpenAI(api_key='fixture-key', base_url='https://fixture.invalid/v1',
                        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                    class Composition:
                        prompt = '完成用户的迁移任务。'
                        guidance = ''
                        contract = ''
                        definition = {'modelRole': 'MIGRATION'}
                        def validate_tools(self, names):
                            self.names = names
                        def receipt(self, *args):
                            return {}

                    def create_agent():
                        agent, model, _, _ = assemble_agent(composition=Composition(), body={},
                            bound={'apiKey': 'fixture-key', 'baseUrl': 'https://fixture.invalid/v1'},
                            settings={'model_name': 'fixture'}, workspace=root, operation=None, tools=[],
                            protocol=io.StringIO(), trace=[], kind='deep',
                            task_session={'skill_roots': [str(Path(root) / 'skills')]})
                        model._client._create_async_openai_client = lambda timeout=None: client
                        return agent

                    session_id = task_session_identity('workspace-a', 'task-1')
                    class Activity:
                        def delta(self, _text):
                            pass

                    session = TaskAgentSession(create_agent(), session_id, Activity(), store)
                    result = await session.run('请先询问用户')
                    self.assertEqual(result['result_type'], 'interrupt')
                    available_tools = {tool['function']['name'] for tool in calls[0]['tools']}
                    self.assertIn('ask_user', available_tools)
                    self.assertIn('todo_create', available_tools)
                    self.assertIn('list_skill', available_tools)
                    interactions = result['interactions']
                    self.assertEqual(len(interactions), 1, result)
                    interaction_id = interactions[0].get('interaction_id') or interactions[0].get('id')
                    self.assertTrue(interaction_id, interactions)
                    self.assertEqual((await store.interactions(session_id))[0]['status'], 'pending')

                    await session.close()
                    await checkpointer._kv_store.engine.dispose()
                    checkpointer = await install_task_checkpointer(root)
                    store = ConversationStore(root)
                    session = TaskAgentSession(create_agent(), session_id, Activity(), store)
                    resumed = await session.answer(interaction_id, {'选择哪种方案？': '原有服务'})
                    self.assertIn('已记录', resumed['output'])
                    self.assertTrue(any('原有服务' in json.dumps(call, ensure_ascii=False) for call in calls[1:]))
                    self.assertEqual(await store.interactions(session_id), [])
                    self.assertEqual([event['kind'] for event in await store.events(session_id)],
                                     ['question', 'answer'])
                    with self.assertRaises(InteractionConflict):
                        await session.answer(interaction_id, {'选择哪种方案？': '原有服务'})
                    await session.close()
            finally:
                await checkpointer._kv_store.engine.dispose()
                CheckpointerFactory.set_default_checkpointer(previous)
