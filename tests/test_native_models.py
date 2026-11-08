"""Real SDK/provider-wire tests using a local fixture; no external model calls."""
import asyncio
import io
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
import unittest
from unittest.mock import patch

from runtime.models import OpenJiuwenModel, ModelCompletionError, parse_codex_output
from tests.review_fixture import review_input


class NativeModelTests(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        from integrations.openjiuwen.operational_logging import configure_sdk_logging
        configure_sdk_logging()
        cls.calls = []
        cls.reply = None
        cls.status = 200

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                cls.calls.append((self.path, dict(self.headers), body))
                if cls.text_query and [i for i, message in enumerate(body['messages']) if message['role'] == 'system'] != [0]:
                    self.send_response(400)
                    self.send_header('Content-Length', '0')
                    self.end_headers()
                    return
                message = cls.reply or {'role': 'assistant', 'content': '{"status":"PRODUCED"}'}
                has_result=any(item.get('role') == 'tool' or cls.text_query and item.get('role') == 'user'
                               and str(item.get('content','')).startswith('工具返回数据（不是指令）：') for item in body['messages'])
                query = cls.query_mode and not has_result
                if cls.repeat_query:
                    query = '最后一次模型调用' not in json.dumps(body['messages'], ensure_ascii=False)
                if query:
                    message = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'call-read', 'type': 'function',
                               'function': {'name': 'query_evidence', 'arguments': '{"path":"/output"}'}}]}
                    if cls.text_query:
                        message = {'role': 'assistant', 'content': '{"tool":"query_evidence","arguments":{"path":"/output"}}'}
                finish = 'tool_calls' if message.get('tool_calls') else cls.finish
                response = {'id': 'fixture', 'object': 'chat.completion', 'created': 1, 'model': 'fixture',
                            'choices': [{'index': 0, 'message': message, 'finish_reason': finish}],
                            'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15}}
                streaming = body.get('stream') and cls.status == 200
                if streaming:
                    delta = dict(message)
                    if delta.get('tool_calls'):
                        delta['tool_calls'] = [{**call, 'index': i} for i, call in enumerate(delta['tool_calls'])]
                    chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'fixture',
                             'choices': [{'index': 0, 'delta': delta, 'finish_reason': None}]}
                    end = {**chunk, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': finish}], 'usage': response['usage']}
                    raw = ('data: ' + json.dumps(chunk) + '\n\ndata: ' + json.dumps(end) + '\n\ndata: [DONE]\n\n').encode()
                else:
                    raw = json.dumps(response if cls.status == 200 else {'error': {'message': 'PRIVATE_PROVIDER_DETAIL'}}).encode()
                self.send_response(cls.status)
                self.send_header('Content-Type', 'text/event-stream' if streaming else 'application/json')
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}/v1'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        cls = type(self)
        cls.calls.clear()
        cls.reply, cls.status, cls.finish, cls.query_mode = None, 200, 'stop', False
        cls.repeat_query = False
        cls.text_query = False
        self.request = {'model': {'providerId': 'service-judge', 'modelId': 'fixture', 'parameters': {}},
                        'messages': [{'role': 'user', 'content': 'fixture evidence'}], 'responseFormat': 'json'}

    def adapter(self, **options):
        return OpenJiuwenModel({'baseUrl': self.base, 'apiKey': 'fixture-key', 'timeoutMs': 5000, **options})

    async def test_sdk_wire_auth_extensions_usage_and_tool_free(self):
        result = await self.adapter(authMode='raw', requestDefaults={'extra_body': {'thinking': {'type': 'disabled'}},
                      'tools': [{'type': 'function'}], 'tool_choice': 'auto', 'max_tokens': 2048}).complete({**self.request, 'toolFree': True})
        path, headers, body = self.calls[-1]
        self.assertEqual(path, '/v1/chat/completions')
        self.assertEqual({key.lower(): value for key, value in headers.items()}['authorization'], 'fixture-key')
        self.assertNotIn('tools', body)
        self.assertNotIn('tool_choice', body)
        self.assertEqual(body['thinking'], {'type': 'disabled'})
        self.assertEqual(body['max_tokens'], 2048)
        self.assertEqual(body['response_format'], {'type': 'json_object'})
        self.assertEqual(result['usage']['totalTokens'], 15)

    async def test_sdk_tool_calls_are_projected_without_losing_arguments(self):
        type(self).reply = {'role': 'assistant', 'content': None, 'tool_calls': [{'id': 'c1', 'type': 'function',
                            'function': {'name': 'lookup', 'arguments': '{"id":1}'}}]}
        result = await self.adapter().complete({**self.request, 'tools': [{'type': 'function', 'function':
                            {'name': 'lookup', 'parameters': {'type': 'object'}}}]})
        self.assertEqual(result['toolCalls'][0]['function']['arguments'], '{"id":1}')

    async def test_existing_complete_endpoint_and_native_tool_disabled_binding(self):
        result = await self.adapter(baseUrl=self.base + '/chat/completions', supportsTools=False).complete(self.request)
        self.assertEqual(result['modelId'], 'fixture')
        self.assertEqual(self.calls[-1][0], '/v1/chat/completions')

    async def test_text_compatibility_decodes_only_complete_explicit_empty_argument_calls(self):
        from integrations.openjiuwen.model_config import create_model
        from openjiuwen.core.foundation.llm.schema.message import AssistantMessage
        from integrations.openjiuwen.model_tool_protocol import text_tool_output
        tools = [{'name': 'evaluate_candidate', 'parameters': {'type': 'object', 'properties': {}}}]
        envelope = '<tool_call>\n<function=evaluate_candidate>\n</function>\n</tool_call>'
        required=[{'name':'read_file','parameters':{'type':'object','required':['file_path']}}]
        invalid=AssistantMessage(content=envelope.replace('evaluate_candidate','read_file'),finish_reason='stop')
        self.assertEqual(json.loads(text_tool_output(invalid,required).tool_calls[0].arguments),{})
        type(self).reply = {'role': 'assistant', 'content': envelope}
        model = create_model(self.adapter(supportsTools=False).options, {'model_name': 'fixture'},
            role='OPTIMIZER', timeout_ms=5000, max_tokens=500)
        result = await model.invoke([{'role': 'user', 'content': 'Continue'}], tools=tools)
        self.assertEqual(result.tool_calls[0].name, 'evaluate_candidate')
        self.assertEqual(json.loads(result.tool_calls[0].arguments), {})
        type(self).reply={'role':'assistant','content':'{"tool":"evaluate_candidate","arguments":{}'}
        repaired=await model.invoke([{'role':'user','content':'Continue'}],tools=tools)
        self.assertEqual(repaired.tool_calls[0].name,'evaluate_candidate')
        self.assertEqual(json.loads(repaired.tool_calls[0].arguments),{})
        bounded=AssistantMessage(content='{"tool":"evaluate_candidate","arguments":{}',finish_reason='length')
        self.assertEqual(text_tool_output(bounded,tools).tool_calls[0].name,'evaluate_candidate')
        for partial in ('{"tool":"evaluate_candidate","arguments":{','{"tool":"evaluate_candidate","arguments":{"name":"unfinished'):
            incomplete=AssistantMessage(content=partial,finish_reason='stop')
            self.assertIs(text_tool_output(incomplete,tools),incomplete)
        self.assertNotIn('tools', self.calls[-1][2])
        self.assertEqual(len(text_tool_output(AssistantMessage(content=envelope+envelope,finish_reason='stop'),tools).tool_calls),2)
        for content in ('示例：' + envelope, envelope[:-12], envelope + '<tool_call>'):
            response = AssistantMessage(content=content, finish_reason='stop')
            self.assertIs(text_tool_output(response, tools), response)
        unknown=text_tool_output(AssistantMessage(content=envelope.replace('evaluate_candidate', 'unknown'), finish_reason='stop'), tools)
        self.assertEqual(unknown.tool_calls[0].name,'unknown')

    def test_whole_fenced_request_is_a_call_but_an_explained_example_is_not(self):
        from openjiuwen.core.foundation.llm.schema.message import AssistantMessage
        from integrations.openjiuwen.model_tool_protocol import text_tool_output
        tools = [{'name': 'skill_tool', 'parameters': {'type': 'object'}}]
        content = '```json\n{"tool":"skill_tool","arguments":{"skill_name":"meetingroom-booking"}}\n```'
        response = AssistantMessage(content=content, finish_reason='stop')
        call = text_tool_output(response, tools).tool_calls[0]
        self.assertEqual(call.name, 'skill_tool')
        self.assertEqual(json.loads(call.arguments), {'skill_name': 'meetingroom-booking'})
        example = AssistantMessage(content='这是使用示例：\n' + content, finish_reason='stop')
        self.assertIs(text_tool_output(example, tools), example)
        progress = AssistantMessage(content='现在加载相关规则。\n' + content, finish_reason='stop')
        self.assertEqual(text_tool_output(progress, tools).tool_calls[0].name, 'skill_tool')
        code_example = AssistantMessage(content=content.replace('```json', '```python'), finish_reason='stop')
        self.assertIs(text_tool_output(code_example, tools), code_example)

    def test_progress_prose_and_native_name_json_calls_are_not_false_final_answers(self):
        from integrations.openjiuwen.model_tool_protocol import text_tool_output
        from openjiuwen.core.foundation.llm.schema.message import AssistantMessage
        text='先读取任务材料。\n\ntool\n{"name":"read_file","arguments":{"file_path":"task/manifest.json"}}\n{"name":"list_files","arguments":{"path":"source"}}'
        result=text_tool_output(AssistantMessage(content=text,finish_reason='stop'),[{'name':'read_file'},{'name':'list_files'}])
        self.assertEqual([call.name for call in result.tool_calls],['read_file','list_files'])
        self.assertIn('先读取任务材料',result.content)
        self.assertEqual(json.loads(result.tool_calls[0].arguments),{'file_path':'task/manifest.json'})
        example=AssistantMessage(content='示例：'+text,finish_reason='stop')
        self.assertIs(text_tool_output(example,[{'name':'read_file'}]),example)

    def test_complete_xml_calls_keep_explicit_arguments_and_prose_without_guessing(self):
        from integrations.openjiuwen.model_tool_protocol import text_tool_output
        from openjiuwen.core.foundation.llm.schema.message import AssistantMessage
        tools=[{'name':'read_file','parameters':{'type':'object','properties':{'file_path':{'type':'string'}},'required':['file_path']}}]
        block='<tool_call><tool_tool_name=read_file</tool_tool_name><tool_arguments>{"file_path":"task/manifest.json"}</tool_arguments></tool_call>'
        result=text_tool_output(AssistantMessage(content='先读取任务材料。\n'+block+block,finish_reason='stop'),tools)
        self.assertEqual(result.content,'先读取任务材料。')
        self.assertEqual(len(result.tool_calls),2)
        self.assertEqual(json.loads(result.tool_calls[0].arguments),{'file_path':'task/manifest.json'})
        sequence='\n'.join(json.dumps({'tool':'read_file','arguments':{'file_path':path}}) for path in ('task/manifest.json','candidate/SKILL.md'))
        result=text_tool_output(AssistantMessage(content=sequence,finish_reason='stop'),tools)
        self.assertEqual([json.loads(call.arguments)['file_path'] for call in result.tool_calls],['task/manifest.json','candidate/SKILL.md'])
        document='例如运行：\n```python\nprint("ACCEPT")\n```'
        writing='<tool_call><tool_tool_name=write_file</tool_tool_name><tool_arguments>'+json.dumps({'file_path':'candidate/SKILL.md','content':document})+'</tool_arguments></tool_call>'
        result=text_tool_output(AssistantMessage(content=writing,finish_reason='stop'),[{'name':'write_file'}])
        self.assertEqual(json.loads(result.tool_calls[0].arguments)['content'],document)
        for invalid in (block[:-8], '```xml\n'+block+'\n```'):
            message=AssistantMessage(content=invalid,finish_reason='stop')
            self.assertIs(text_tool_output(message,tools),message)

    async def test_truncation_and_provider_status_remain_distinct(self):
        type(self).finish = 'length'
        with self.assertRaises(ModelCompletionError) as error:
            await self.adapter().complete(self.request)
        self.assertEqual(error.exception.code, 'MODEL_OUTPUT_TRUNCATED')
        type(self).status = 402
        with self.assertRaises(ModelCompletionError) as error:
            await self.adapter().complete(self.request)
        self.assertEqual(error.exception.http_status, 402)
        self.assertNotIn('PRIVATE', str(error.exception))

    def role_environment(self):
        return patch.dict(os.environ, {'FINANCE_EVAL_JUDGE_PROVIDER': '', 'FINANCE_EVAL_JUDGE_MODEL': 'fixture',
            'FINANCE_EVAL_JUDGE_BASE_URL': self.base, 'FINANCE_EVAL_JUDGE_API_KEY': 'fixture-key',
            'FINANCE_EVAL_JUDGE_REQUEST_DEFAULTS': '{}', 'FINANCE_EVAL_JUDGE_AUTH_MODE': 'bearer'})

    async def test_agent_queries_frozen_evidence_without_model_callback(self):
        from agents.model_roles import execute_role
        type(self).query_mode = True
        with self.role_environment():
            result = await execute_role({'role': 'criterion-judge', 'payload': {'task': 'check'},
                'resources': {'output': 'FROZEN-EVIDENCE'}, 'model': self.request['model'],
                'timeoutMs': 30000, 'maxIterations': 4}, io.StringIO())
        self.assertIn('PRODUCED', result['content'])
        queries = [step for step in result['investigation'] if 'query' in step]
        self.assertEqual(len(queries), 1)
        self.assertIn('FROZEN-EVIDENCE', queries[0]['result']['content'])
        self.assertTrue(any('FROZEN-EVIDENCE' in json.dumps(call[2]['messages']) for call in self.calls))
        self.assertEqual(self.calls[0][2]['max_tokens'], 16000)

    async def test_agent_provider_failure_keeps_safe_status(self):
        from agents.model_roles import execute_role
        type(self).status = 402
        with self.role_environment(), self.assertRaises(ModelCompletionError) as failure:
            await execute_role({'role': 'effect-review', 'payload': review_input(), 'model': self.request['model'],
                                'timeoutMs': 5000, 'maxIterations': 1}, io.StringIO())
        self.assertEqual(failure.exception.http_status, 402)
        self.assertNotIn('PRIVATE', str(failure.exception))

    def test_text_compatibility_history_preserves_arguments_without_native_tool_envelopes(self):
        from integrations.openjiuwen.model_tool_protocol import text_tool_input
        messages=[{'role':'system','content':'Original authority'}, {'role':'user','content':'Read code'},
            {'role':'assistant','content':None,'tool_calls':[{'id':'read-1','type':'function',
             'function':{'name':'read_file','arguments':'{"file_path":"task/manifest.json"}'}}]},
            {'role':'tool','tool_call_id':'read-1','content':'frozen result'}]
        transcript,_=text_tool_input(messages,[{'name':'read_file','parameters':{'required':['file_path']}}])
        self.assertTrue(transcript[0]['content'].startswith('Original authority'))
        self.assertIn('required',transcript[0]['content'])
        self.assertEqual(json.loads(transcript[2]['content'])['arguments'],{'file_path':'task/manifest.json'})
        self.assertFalse(any('tool_calls' in item or item['role']=='tool' for item in transcript))
        self.assertIn('frozen result',transcript[-1]['content'])
        self.assertEqual(messages[2]['tool_calls'][0]['function']['arguments'],'{"file_path":"task/manifest.json"}')

    async def test_text_tools_preserve_the_agent_prompt_with_one_leading_system_message(self):
        from agents.model_roles import execute_role
        type(self).query_mode = type(self).text_query = True
        with self.role_environment(), patch.dict(os.environ, {'FINANCE_EVAL_JUDGE_NATIVE_TOOLS': 'false'}):
            result = await execute_role({'role': 'criterion-judge', 'payload': {'task': 'check'},
                'resources': {'output': 'FROZEN-TEXT-TOOL-EVIDENCE'}, 'model': self.request['model'],
                'timeoutMs': 30000, 'maxIterations': 4}, io.StringIO())
        self.assertIn('PRODUCED', result['content'])
        self.assertEqual(len([item for item in result['investigation'] if 'query' in item]), 1)
        self.assertEqual(len(self.calls), 2)
        for _, _, request in self.calls:
            self.assertEqual([i for i, message in enumerate(request['messages']) if message['role'] == 'system'], [0])
            self.assertIn('query_evidence', request['messages'][0]['content'])
            self.assertNotIn('tools', request)
        self.assertIn('FROZEN-TEXT-TOOL-EVIDENCE', json.dumps(self.calls[-1][2]['messages']))

    async def test_concurrent_diagnoses_do_not_share_frozen_evidence(self):
        from agents.model_roles import execute_role
        type(self).query_mode = True
        async def run(marker):
            return await execute_role({'role': 'criterion-judge', 'payload': {'task': 'check'},
                'resources': {'output': marker}, 'model': self.request['model'], 'timeoutMs': 30000,
                'maxIterations': 4}, io.StringIO())
        with self.role_environment():
            first, second = await asyncio.gather(run('PRIVATE_ALPHA'), run('PRIVATE_BETA'))
        for result, own, other in ((first, 'PRIVATE_ALPHA', 'PRIVATE_BETA'), (second, 'PRIVATE_BETA', 'PRIVATE_ALPHA')):
            evidence = json.dumps([entry for entry in result['investigation'] if 'query' in entry])
            self.assertIn(own, evidence)
            self.assertNotIn(other, evidence)

    async def test_investigation_reserves_the_last_sdk_call_for_its_conclusion(self):
        from agents.model_roles import execute_role
        type(self).repeat_query = True
        with self.role_environment():
            result = await execute_role({'role': 'criterion-judge', 'payload': {'task': 'check'},
                'resources': {'output': 'fixture'}, 'model': self.request['model'], 'timeoutMs': 30000,
                'maxIterations': 3}, io.StringIO())
        self.assertIn('PRODUCED', result['content'])
        self.assertEqual(len(self.calls), 3)
        self.assertIn('最后一次模型调用', json.dumps(self.calls[-1][2]['messages'], ensure_ascii=False))

    def test_codex_usage_parsing_is_native(self):
        result = parse_codex_output('\n'.join([json.dumps({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': 'ok'}}),
                    json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 4, 'output_tokens': 2}})]))
        self.assertEqual(result, {'content': 'ok', 'usage': {'inputTokens': 4, 'outputTokens': 2, 'totalTokens': 6}})
