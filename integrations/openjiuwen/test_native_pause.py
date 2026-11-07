"""Verify the installed SDK's native pause semantics before host integration."""
import asyncio
import json
import tempfile
import unittest


class NativePauseTests(unittest.IsolatedAsyncioTestCase):
    async def test_running_harness_accepts_steering_during_a_tool(self):
        import httpx
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm.model import init_model
        from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
        from openjiuwen.harness.factory import resolve_deep_agent_parts
        from openjiuwen.agent_teams.harness.native_harness import NativeHarness

        started, release, completed = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls = []

        async def respond(request):
            calls.append(json.loads(request.content))
            if len(calls) == 1:
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'steer-call', 'type': 'function',
                    'function': {'name': 'wait_example', 'arguments': '{}'}}]}
                finish = 'tool_calls'
            else:
                delta, finish = {'role': 'assistant', 'content': '已处理补充要求'}, 'stop'
            chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'fixture',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                  text='data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\ndata: [DONE]\n\n')

        async def tool():
            started.set()
            await release.wait()
            return {'result': '工具完成'}

        async def on_round(*, kind, **_kwargs):
            if kind in ('finished', 'failed'):
                completed.set()

        with tempfile.TemporaryDirectory() as root:
            async with AsyncOpenAI(api_key='fixture', base_url='https://fixture.invalid/v1',
                    http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                model = init_model('OpenAI', 'fixture', 'fixture', 'https://fixture.invalid/v1')
                model._client._create_async_openai_client = lambda timeout=None: client
                capability = LocalFunction(ToolCard(id='native-steer-test', name='wait_example', description='Wait example',
                    input_params={'type': 'object', 'properties': {}}), tool)

                class Spec:
                    def resolve_parts(self, _context):
                        return resolve_deep_agent_parts(model, system_prompt='完成用户任务', tools=[capability], workspace=root,
                            auto_create_workspace=False, enable_task_loop=False, enable_read_image_multimodal=False,
                            max_iterations=5, prompt_mode='minimal')

                harness = NativeHarness(Spec())
                await harness.subscribe(on_round=on_round)
                await harness.start()
                try:
                    await harness.send('处理任务')
                    await asyncio.wait_for(started.wait(), 30)
                    await asyncio.wait_for(harness.send('补充要求：保留原始配置', immediate=True), 5)
                    release.set()
                    await asyncio.wait_for(completed.wait(), 30)
                    self.assertIn('补充要求：保留原始配置', json.dumps(calls[-1]['messages'], ensure_ascii=False))
                finally:
                    release.set()
                    await harness.stop()

    async def test_native_harness_delivers_and_resumes_ask_user(self):
        import httpx
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm.model import init_model
        from openjiuwen.core.session import InteractiveInput
        from openjiuwen.core.session.agent import create_agent_session
        from openjiuwen.core.single_agent.schema.agent_card import AgentCard
        from .agent_session import emit_round_boundary
        from openjiuwen.harness.factory import resolve_deep_agent_parts
        from openjiuwen.harness.rails.interrupt.ask_user_rail import AskUserRail
        from openjiuwen.agent_teams.harness.native_harness import NativeHarness
        from openjiuwen.agent_teams.harness.state import HarnessState

        asked, finished = asyncio.Event(), asyncio.Event()
        interactions, calls, round_results, ordered = [], [], [], []
        sdk_session = None

        async def respond(request):
            calls.append(json.loads(request.content))
            if len(calls) == 1:
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'ask-native', 'type': 'function',
                    'function': {'name': 'ask_user', 'arguments': json.dumps({'questions': [{'header': '服务',
                        'question': '如何处理服务？', 'options': [{'label': '保留', 'description': '保留服务'}]}]}, ensure_ascii=False)}}]}
                finish = 'tool_calls'
            else:
                delta, finish = {'role': 'assistant', 'content': '按回答继续'}, 'stop'
            chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'fixture',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                  text='data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\ndata: [DONE]\n\n')

        async def on_round(*, kind, round_id, result=None, **_kwargs):
            if kind == 'finished':
                round_results.append(result)
                await emit_round_boundary(sdk_session, round_id, result.get('result_type'))
            if kind == 'finished' and isinstance(result, dict) and result.get('result_type') != 'interrupt':
                finished.set()

        with tempfile.TemporaryDirectory() as root:
            async with AsyncOpenAI(api_key='fixture', base_url='https://fixture.invalid/v1',
                    http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                model = init_model('OpenAI', 'fixture', 'fixture', 'https://fixture.invalid/v1')
                model._client._create_async_openai_client = lambda timeout=None: client

                class Spec:
                    def resolve_parts(self, _context):
                        return resolve_deep_agent_parts(model, system_prompt='需要信息时询问用户', tools=[], workspace=root,
                            rails=[AskUserRail()], auto_create_workspace=False, enable_task_loop=False,
                            enable_read_image_multimodal=False, max_iterations=5, prompt_mode='minimal')

                harness = NativeHarness(Spec())
                await harness.subscribe(on_round=on_round)
                sdk_session = create_agent_session(session_id='native-ask-barrier', card=harness.card, close_stream_on_post_run=False)
                await sdk_session.pre_run(inputs=None)
                await harness.start(session=sdk_session)

                async def consume():
                    async for chunk in harness.outputs():
                        data = chunk.model_dump() if hasattr(chunk, 'model_dump') else chunk
                        if isinstance(data, dict):
                            ordered.append(data.get('type'))
                        if isinstance(data, dict) and data.get('type') == '__interaction__':
                            interactions.append(data['payload'])
                            asked.set()

                consumer = asyncio.create_task(consume())
                try:
                    await harness.send('请处理服务')
                    await asyncio.wait_for(asked.wait(), 30)
                    for _ in range(100):
                        if harness.state == HarnessState.IDLE:
                            break
                        await asyncio.sleep(0.01)
                    self.assertEqual(harness.state, HarnessState.IDLE)
                    self.assertEqual(round_results[0].get('result_type'), 'interrupt')
                    # IDs arrive on the output stream, not in the round result.
                    self.assertFalse(round_results[0].get('interactions'))
                    for _ in range(100):
                        if 'platform_round_end' in ordered:
                            break
                        await asyncio.sleep(0.01)
                    self.assertLess(ordered.index('__interaction__'), ordered.index('platform_round_end'))
                    interaction_id = interactions[0].get('interaction_id') or interactions[0].get('id')
                    self.assertTrue(interaction_id)
                    answer = InteractiveInput()
                    answer.update(interaction_id, {'answers': {'如何处理服务？': '保留'}})
                    await harness.send(answer)
                    await asyncio.wait_for(finished.wait(), 30)
                    self.assertIn('保留', json.dumps(calls[-1]['messages'], ensure_ascii=False))
                finally:
                    await harness.stop()
                    await asyncio.wait_for(consumer, 10)

    async def test_checkpoint_can_continue_after_new_harness_instance(self):
        import httpx
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm.model import init_model
        from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
        from openjiuwen.core.session.agent import create_agent_session
        from openjiuwen.core.session.checkpointer import CheckpointerFactory
        from openjiuwen.harness.factory import resolve_deep_agent_parts
        from openjiuwen.agent_teams.harness.native_harness import NativeHarness
        from .agent_session import install_task_checkpointer, task_agent_card

        started, release, completed = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls, tool_runs, results = [], [], []

        async def respond(request):
            calls.append(json.loads(request.content))
            if len(calls) == 1:
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'cold-call', 'type': 'function',
                    'function': {'name': 'cold_record', 'arguments': '{}'}}]}
                finish = 'tool_calls'
            else:
                delta, finish = {'role': 'assistant', 'content': '恢复完成'}, 'stop'
            chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'fixture',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                  text='data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\ndata: [DONE]\n\n')

        async def tool():
            tool_runs.append('once')
            started.set()
            await release.wait()
            return {'result': '已执行一次'}

        async def on_round(*, kind, result=None, **_kwargs):
            if kind in ('finished', 'failed'):
                results.append((kind, result))
                completed.set()

        previous = CheckpointerFactory._default_checkpointer
        checkpointer = None
        try:
            with tempfile.TemporaryDirectory() as root:
                checkpointer = await install_task_checkpointer(root)
                async with AsyncOpenAI(api_key='fixture', base_url='https://fixture.invalid/v1',
                        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                    model = init_model('OpenAI', 'fixture', 'fixture', 'https://fixture.invalid/v1')
                    model._client._create_async_openai_client = lambda timeout=None: client
                    card = task_agent_card()

                    class Spec:
                        def resolve_parts(self, _context):
                            capability = LocalFunction(ToolCard(id='cold-pause-test', name='cold_record', description='Record example',
                                input_params={'type': 'object', 'properties': {}}), tool)
                            return resolve_deep_agent_parts(model, card=card, system_prompt='完成用户任务', tools=[capability], workspace=root,
                                auto_create_workspace=False, enable_task_loop=False, enable_read_image_multimodal=False,
                                max_iterations=5, prompt_mode='minimal')

                    first_session = create_agent_session(session_id='cold-pause-session', card=card, close_stream_on_post_run=False)
                    await first_session.pre_run(inputs=None)
                    first = NativeHarness(Spec())
                    await first.start(session=first_session)
                    try:
                        await first.send('只执行一次工具')
                        await asyncio.wait_for(started.wait(), 30)
                        pausing = asyncio.create_task(first.pause())
                        await asyncio.sleep(0.05)
                        self.assertFalse(pausing.done())
                        release.set()
                        await asyncio.wait_for(pausing, 15)
                        query = first.paused_query
                        await first_session.commit()
                    finally:
                        release.set()
                        await first.stop()

                    second_session = create_agent_session(session_id='cold-pause-session', card=card, close_stream_on_post_run=False)
                    await second_session.pre_run(inputs=None)
                    second = NativeHarness(Spec())
                    await second.subscribe(on_round=on_round)
                    await second.start(session=second_session)
                    try:
                        await second.resume(query=query)
                        await asyncio.wait_for(completed.wait(), 30)
                        self.assertEqual(results[-1][0], 'finished')
                        self.assertEqual(tool_runs, ['once'])
                        self.assertIn('已执行一次', json.dumps(calls[-1]['messages'], ensure_ascii=False))
                    finally:
                        await second.stop()
                        await checkpointer._kv_store.engine.dispose()
                        checkpointer = None
        finally:
            if checkpointer is not None:
                await checkpointer._kv_store.engine.dispose()
            CheckpointerFactory.set_default_checkpointer(previous)

    async def test_tool_finishes_once_before_pause_acknowledgement(self):
        import httpx
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm.model import init_model
        from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
        from openjiuwen.harness.factory import resolve_deep_agent_parts
        from openjiuwen.agent_teams.harness.native_harness import NativeHarness
        from openjiuwen.agent_teams.harness.state import HarnessState

        started, release, completed = asyncio.Event(), asyncio.Event(), asyncio.Event()
        calls, tool_runs, results = [], [], []

        async def respond(request):
            calls.append(json.loads(request.content))
            if len(calls) == 1:
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'fixture-call', 'type': 'function',
                    'function': {'name': 'record_example', 'arguments': '{}'}}]}
                finish = 'tool_calls'
            else:
                delta, finish = {'role': 'assistant', 'content': '已完成'}, 'stop'
            chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'fixture',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                  text='data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\ndata: [DONE]\n\n')

        async def tool():
            tool_runs.append('started')
            started.set()
            await release.wait()
            tool_runs.append('finished')
            return {'status': 'done'}

        async def on_round(*, kind, result=None, **_kwargs):
            if kind in ('finished', 'failed'):
                results.append((kind, result))
                completed.set()

        with tempfile.TemporaryDirectory() as root:
            async with AsyncOpenAI(api_key='fixture', base_url='https://fixture.invalid/v1',
                    http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                model = init_model('OpenAI', 'fixture', 'fixture', 'https://fixture.invalid/v1')
                model._client._create_async_openai_client = lambda timeout=None: client
                capability = LocalFunction(ToolCard(id='native-pause-test', name='record_example', description='Record example',
                    input_params={'type': 'object', 'properties': {}}), tool)

                class Spec:
                    def resolve_parts(self, _context):
                        return resolve_deep_agent_parts(model, system_prompt='完成用户任务', tools=[capability], workspace=root,
                            auto_create_workspace=False, enable_task_loop=False, enable_read_image_multimodal=False,
                            max_iterations=5, prompt_mode='minimal')

                harness = NativeHarness(Spec())
                await harness.subscribe(on_round=on_round)
                await harness.start()
                try:
                    await harness.send('请调用工具')
                    await asyncio.wait_for(started.wait(), 30)
                    pausing = asyncio.create_task(harness.pause())
                    await asyncio.sleep(0.05)
                    self.assertFalse(pausing.done())
                    release.set()
                    await asyncio.wait_for(pausing, 15)
                    self.assertEqual(harness.state, HarnessState.PAUSED)
                    self.assertEqual(tool_runs, ['started', 'finished'])
                    await harness.resume()
                    await asyncio.wait_for(completed.wait(), 30)
                    self.assertEqual(results[-1][0], 'finished')
                    self.assertEqual(tool_runs, ['started', 'finished'])
                finally:
                    release.set()
                    await harness.stop()

    async def test_model_call_pause_resumes_from_framework_boundary(self):
        import httpx
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm.model import init_model
        from openjiuwen.harness.factory import resolve_deep_agent_parts
        from openjiuwen.agent_teams.harness.native_harness import NativeHarness
        from openjiuwen.agent_teams.harness.state import HarnessState

        started = asyncio.Event()
        completed = asyncio.Event()
        calls = []
        chunks = []
        results = []

        async def respond(request):
            calls.append(json.loads(request.content))
            if len(calls) == 1:
                started.set()
                await asyncio.Event().wait()
            chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'fixture',
                     'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': '已继续任务'}, 'finish_reason': 'stop'}]}
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                  text='data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\ndata: [DONE]\n\n')

        async def on_round(*, kind, result=None, **_kwargs):
            if kind in ('finished', 'failed'):
                results.append((kind, result))
                completed.set()

        with tempfile.TemporaryDirectory() as root:
            async with AsyncOpenAI(api_key='fixture', base_url='https://fixture.invalid/v1',
                    http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                model = init_model('OpenAI', 'fixture', 'fixture', 'https://fixture.invalid/v1')
                model._client._create_async_openai_client = lambda timeout=None: client

                class Spec:
                    def resolve_parts(self, _context):
                        return resolve_deep_agent_parts(model, system_prompt='完成用户任务', tools=[], workspace=root,
                            auto_create_workspace=False, enable_task_loop=False, enable_read_image_multimodal=False,
                            max_iterations=5, prompt_mode='minimal')

                harness = NativeHarness(Spec())
                await harness.subscribe(on_round=on_round)
                await harness.start()
                async def consume():
                    async for chunk in harness.outputs():
                        chunks.append(chunk.model_dump() if hasattr(chunk, 'model_dump') else chunk)
                consumer = asyncio.create_task(consume())
                try:
                    await harness.send('请完成任务')
                    await asyncio.wait_for(started.wait(), 30)
                    await asyncio.wait_for(harness.pause(), 15)
                    self.assertEqual(harness.state, HarnessState.PAUSED)
                    self.assertEqual(harness.paused_query, '请完成任务')
                    await harness.resume()
                    await asyncio.wait_for(completed.wait(), 30)
                    self.assertEqual(results[-1][0], 'finished')
                    self.assertIn('已继续任务', str(results[-1][1]))
                    self.assertEqual(len(calls), 2)
                finally:
                    await harness.stop()
                    await asyncio.wait_for(consumer, 10)
                self.assertIn('已继续任务', json.dumps(chunks, ensure_ascii=False, default=str))
                self.assertTrue(any(isinstance(chunk, dict) and chunk.get('type') == 'round_aborted' for chunk in chunks))


if __name__ == '__main__':
    unittest.main()
