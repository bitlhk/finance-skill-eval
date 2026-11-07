import io
import json
import sys
import unittest
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from agent_activity import ActivityRail, AgentStreamAccumulator, stream_agent


class StreamTests(unittest.IsolatedAsyncioTestCase):
    async def test_model_error_reports_safe_diagnosis_without_provider_details(self):
        from types import SimpleNamespace
        output = io.StringIO()
        rail = ActivityRail(output, ['private-key'])
        await rail.on_model_exception(SimpleNamespace(exception=RuntimeError('status code: 402 private-key prompt data')))
        await rail.on_model_exception(SimpleNamespace(exception=RuntimeError('HTTP 429 private-key prompt data')))
        await rail.on_model_exception(SimpleNamespace(exception=TimeoutError('private-key prompt data')))
        await rail.on_model_exception(SimpleNamespace(exception=RuntimeError('private-key prompt data')))
        events = [json.loads(line)['activity'] for line in output.getvalue().splitlines()]
        self.assertEqual([item['label'] for item in events], [
            '模型请求失败（HTTP 402）', '模型请求失败（HTTP 429），请检查服务限流或配额后重试',
            '模型请求超时', '模型请求失败，请检查模型服务及网络'])
        self.assertNotIn('private-key', output.getvalue())
        self.assertNotIn('prompt data', output.getvalue())
        await rail.before_model_call(SimpleNamespace())
        self.assertIsNone(rail.last_model_error)
        await rail.on_model_exception(SimpleNamespace(exception=RuntimeError('HTTP 429 private-key')))
        await rail.after_model_call(SimpleNamespace(inputs=SimpleNamespace(response=SimpleNamespace(content='ok'))))
        self.assertIsNone(rail.last_model_error)

    async def test_archive_failure_is_reported_once_and_saved_to_conversation(self):
        class Store:
            def __init__(self): self.events = []
            async def append(self, session, _key, kind, payload): self.events.append((session, kind, payload))
        output=io.StringIO()
        store=Store()
        activity=ActivityRail(output)
        activity.attach_conversation(store,'task-a')
        accumulator=AgentStreamAccumulator(activity)
        state={'type':'context.compression_state','payload':{'status':'failed',
            'error':'压缩归档保存失败，保留原始上下文: private-path'}}
        accumulator.feed(state)
        accumulator.feed(state)
        await activity.flush()
        self.assertEqual(len(store.events),1)
        self.assertEqual(store.events[0][0:2],('task-a','warning'))
        self.assertIn('已保留原始内容',store.events[0][2]['label'])
        self.assertNotIn('private-path',output.getvalue())
        other=ActivityRail(io.StringIO())
        other.attach_conversation(store,'task-b')
        AgentStreamAccumulator(other).feed({'type':'context.compression_state','payload':{'status':'completed'}})
        await other.flush()
        self.assertEqual(len(store.events),1)

    async def test_shared_round_accumulator_retains_streamed_question_identity(self):
        output = io.StringIO()
        accumulator = AgentStreamAccumulator(ActivityRail(output))
        accumulator.feed({'type': 'llm_output', 'payload': {'content': '请确认'}})
        accumulator.feed({'type': '__interaction__', 'payload': {'id': 'question-1', 'value': {'questions': []}}})
        accumulator.feed({'type': 'answer', 'payload': {'output': '暂时结束'}})
        self.assertEqual(accumulator.result(), {'result_type': 'interrupt',
            'interactions': [{'id': 'question-1', 'value': {'questions': []}}], 'output': '请确认'})

    async def test_aborted_stream_output_is_not_reused_after_framework_rewind(self):
        output = io.StringIO()
        accumulator = AgentStreamAccumulator(ActivityRail(output))
        accumulator.feed({'type': 'llm_output', 'payload': {'content': '未完成的回答'}})
        accumulator.feed({'type': 'round_aborted', 'payload': {'round_id': 1, 'kind': 'pause'}})
        accumulator.feed({'type': 'llm_output', 'payload': {'content': '继续后的回答'}})
        self.assertEqual(accumulator.result()['output'], '继续后的回答')
        events = [json.loads(line)['activity'] for line in output.getvalue().splitlines()]
        self.assertTrue(any(event['kind'] == 'round_aborted' for event in events))
        self.assertEqual(events[-1]['text'], '继续后的回答')

    async def test_submitted_review_survives_resume_and_stays_with_its_attempt(self):
        from .agent_conversation_store import ConversationStore
        with tempfile.TemporaryDirectory() as root:
            store=ConversationStore(root)
            await store.initialize()
            await store.append('session','review-1','delivery_review',{'attemptId':'attempt-1','decision':'RECOMMEND','workspaceDigest':'one'})
            await store.append('session','review-2','delivery_review',{'attemptId':'attempt-2','decision':'REVISE','workspaceDigest':'two'})
            resumed=ActivityRail(io.StringIO())
            resumed.attach_conversation(store,'session',attempt_id='attempt-1')
            self.assertEqual(await resumed.persisted_delivery_reviews(),[{'decision':'RECOMMEND','workspaceDigest':'one'}])

    async def test_native_delivery_review_is_recorded_as_advice_not_acceptance(self):
        from types import SimpleNamespace
        class Store:
            def __init__(self): self.events = []
            async def append(self, _session, _key, kind, payload): self.events.append((kind, payload))
        store = Store()
        rail = ActivityRail(io.StringIO(), ['private-key'])
        current = ['example-digest']
        rail.attach_conversation(store, 'session', candidate_digest=lambda:current[0])
        inputs=SimpleNamespace(tool_name='task_tool', tool_call=SimpleNamespace(id='review-1'),
            tool_args={'subagent_type':'migration_delivery_reviewer'},
            tool_result=SimpleNamespace(success=True, data={'output':'审查源码后建议补充测试 private-key'}))
        await rail.before_tool_call(SimpleNamespace(inputs=inputs))
        await rail.after_tool_call(SimpleNamespace(inputs=inputs))
        await rail.flush()
        products = [payload for kind, payload in store.events if kind == 'work_product']
        self.assertEqual(len(products), 1)
        self.assertEqual(products[0]['title'], '独立交付审查建议')
        self.assertEqual(products[0]['workspaceDigest'], 'example-digest')
        self.assertEqual(products[0]['reviewStability'], 'stable_boundaries')
        self.assertNotIn('private-key', products[0]['content'])
        self.assertNotIn('verified', products[0])
        inputs.tool_call.id='review-2'
        await rail.before_tool_call(SimpleNamespace(inputs=inputs))
        current[0]='changed'
        await rail.after_tool_call(SimpleNamespace(inputs=inputs))
        await rail.flush()
        changed=[payload for kind,payload in store.events if kind=='work_product'][-1]
        self.assertEqual(changed['reviewStability'],'changed')
        self.assertNotIn('workspaceDigest',changed)

    async def test_project_command_failure_is_reported_with_redacted_evidence(self):
        from types import SimpleNamespace
        for status in ('FAILED', 'UNAVAILABLE', 'TIMEOUT'):
            with self.subTest(status=status):
                output = io.StringIO()
                rail = ActivityRail(output, ['secret-token'])
                await rail.after_tool_call(SimpleNamespace(inputs=SimpleNamespace(
                    tool_name='run_project_command', tool_result={'status': status, 'output': 'failure secret-token'})))
                event = json.loads(output.getvalue())['activity']
                self.assertEqual(event['kind'], 'tool_error')
                self.assertEqual(event['text'], 'failure [redacted]')
        output = io.StringIO()
        await ActivityRail(output).after_tool_call(SimpleNamespace(inputs=SimpleNamespace(
            tool_name='run_project_command', tool_result={'status': 'COMPLETED', 'output': 'ok'})))
        self.assertEqual(json.loads(output.getvalue())['activity']['kind'], 'tool_end')

    async def test_rejected_operation_explains_reason_in_conversation(self):
        from types import SimpleNamespace
        output = io.StringIO()
        rail = ActivityRail(output, ['secret-token'])
        await rail.after_tool_call(SimpleNamespace(inputs=SimpleNamespace(
            tool_name='request_optimization', tool_result={'accepted': False, 'reason': '缺少真实基线 secret-token'})))
        event = json.loads(output.getvalue())['activity']
        self.assertEqual(event['kind'], 'tool_error')
        self.assertEqual(event['text'], '缺少真实基线 [redacted]')

    async def test_empty_model_response_is_visible_but_tool_only_response_is_valid(self):
        from types import SimpleNamespace
        output = io.StringIO()
        rail = ActivityRail(output)
        await rail.after_model_call(SimpleNamespace(inputs=SimpleNamespace(
            response=SimpleNamespace(content='', tool_calls=[]))))
        self.assertIn('已完成验证已保留', rail.last_model_error)
        self.assertEqual(json.loads(output.getvalue().splitlines()[-1])['activity']['kind'], 'model_error')
        await rail.before_model_call(SimpleNamespace())
        await rail.after_model_call(SimpleNamespace(inputs=SimpleNamespace(
            response=SimpleNamespace(content='', tool_calls=[{'name': 'read_file'}]))))
        self.assertIsNone(rail.last_model_error)

    async def test_real_harness_stream_fires_model_events(self):
        import tempfile
        import httpx
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm.model import init_model
        from openjiuwen.harness import DeepAgent, DeepAgentConfig
        from openjiuwen.core.single_agent.schema.agent_card import AgentCard
        model = init_model('OpenAI', 'fixture', 'fixture-key', 'https://fixture.invalid/v1')
        def respond(request):
            chunk={'id':'fixture','object':'chat.completion.chunk','created':0,'model':'fixture',
                   'choices':[{'index':0,'delta':{'role':'assistant','content':'{"status":"PRODUCED"}'},'finish_reason':'stop'}]}
            return httpx.Response(200,headers={'content-type':'text/event-stream'},text='data: '+json.dumps(chunk)+'\n\ndata: [DONE]\n\n')
        async with AsyncOpenAI(api_key='fixture-key',base_url='https://fixture.invalid/v1',http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as sdk:
            model._client._create_async_openai_client=lambda timeout=None:sdk
            with tempfile.TemporaryDirectory() as workspace:
                agent=DeepAgent(AgentCard(id='activity-test',name='activity-test',description='test'))
                agent.configure(DeepAgentConfig(model=model,cwd=workspace,project_root=workspace,enable_task_loop=False,enable_plan_mode=False,enable_read_image_multimodal=False,auto_create_workspace=False))
                output=io.StringIO();rail=ActivityRail(output,['fixture-key']);agent.add_rail(rail)
                result=await stream_agent(agent,{'query':'Return JSON','conversation_id':'activity-test'},rail)
                self.assertEqual(json.loads(result['output'])['status'],'PRODUCED')
                kinds=[json.loads(line)['activity']['kind'] for line in output.getvalue().splitlines()]
                self.assertIn('model_start',kinds);self.assertIn('text_snapshot',kinds)
    async def test_stream_keeps_final_answer_and_redacts_split_secrets(self):
        class Agent:
            async def stream(self, inputs):
                for text in ['hello sk-', 'secret!']:
                    yield {'type': 'llm_output', 'payload': {'content': text}}
                yield {'type': 'answer', 'payload': {'output': '{"status":"PRODUCED"}'}}
        output = io.StringIO()
        result = await stream_agent(Agent(), {}, ActivityRail(output, ['sk-secret']))
        self.assertEqual(result['output'], '{"status":"PRODUCED"}')
        events = [json.loads(line)['activity'] for line in output.getvalue().splitlines()]
        self.assertEqual(len(events), 2)
        self.assertNotIn('sk-', output.getvalue())
        self.assertIn('[redacted]', events[-1]['text'])

    async def test_stream_error_and_empty_response_are_not_success(self):
        class Empty:
            async def stream(self, inputs):
                if False:
                    yield None
        with self.assertRaisesRegex(RuntimeError, 'no answer'):
            await stream_agent(Empty(), {}, ActivityRail(io.StringIO()))
        class Failed:
            async def stream(self, inputs):
                yield {'type':'answer','payload':{'result_type':'error','output':'fixture failure'}}
        with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
            await stream_agent(Failed(), {}, ActivityRail(io.StringIO()))
