import io
import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from agent_activity import ActivityRail, stream_agent


class StreamTests(unittest.IsolatedAsyncioTestCase):
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
