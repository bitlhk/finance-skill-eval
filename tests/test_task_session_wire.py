"""Exercise the real migration entry and SDK checkpoint across processes."""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread
import unittest


class TaskSessionWireTests(unittest.TestCase):
    def test_ask_user_resume_reuses_checkpoint_and_workspace(self):
        requests = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append(body)
                answered = any(item.get('role') == 'tool' and '保留服务' in str(item.get('content'))
                               for item in body.get('messages', []))
                if answered:
                    delta = {'role': 'assistant', 'content': json.dumps(
                        {'status': 'ABSTAINED', 'reason': '已收到用户选择：保留服务'}, ensure_ascii=False)}
                    finish = 'stop'
                else:
                    delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'ask-1', 'type': 'function',
                        'function': {'name': 'ask_user', 'arguments': json.dumps({'questions': [{
                            'header': '服务', 'question': '如何处理服务？', 'options': [
                                {'label': '保留服务', 'description': '保留当前服务'}]}]}, ensure_ascii=False)}}]}
                    finish = 'tool_calls'
                chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 1, 'model': 'fixture',
                         'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
                if not body.get('stream'):
                    payload = json.dumps({'id': 'fixture', 'object': 'chat.completion', 'created': 1,
                        'model': 'fixture', 'choices': [{'index': 0, 'message': delta, 'finish_reason': finish}]},
                        ensure_ascii=False).encode()
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.send_header('Content-Length', str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
                payload = ('data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\ndata: [DONE]\n\n').encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Content-Length', str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(__file__).resolve().parents[1]
                config = Path(directory) / 'runtime.json'
                config.write_text(json.dumps({'models': {'fixture': {'enabled': True,
                    'providerId': 'service-execution', 'apiKey': 'fixture-key', 'supportsTools':True,
                    'baseUrl': f'http://127.0.0.1:{server.server_port}/v1', 'upstreamModelId': 'fixture'}}}), encoding='utf-8')
                skill = base64.b64encode(b'---\nname: fixture\ndescription: test\n---\nTest.').decode()
                body = {'model': {'modelId': 'fixture', 'providerId': 'service-execution'},
                    'runId': 'fixture-run', 'assetDigest': 'a' * 64, 'maxIterations': 4,
                    'modelTimeoutMs': 15000, 'files': {'SKILL.md': skill},
                    'checkpointRoot': directory, 'correlation': {'taskId': 'bundle-1111', 'attemptId': 'attempt-1111'},
                    'taskSession': {}, 'bundle': {'mode': 'CHAT', 'source': {'files': {'SKILL.md': skill}}}}

                def invoke(request):
                    completed = subprocess.run([sys.executable, 'integrations/openjiuwen/platform_agent.py'],
                        cwd=root, input=json.dumps(request, ensure_ascii=False), text=True, capture_output=True,
                        timeout=60, env={**os.environ, 'FINANCE_RUNTIME_CONFIG': str(config), 'TMPDIR': directory})
                    self.assertEqual(completed.returncode, 0, completed.stderr[-2500:])
                    return json.loads(completed.stdout.strip().splitlines()[-1])['result']

                first = invoke(body)
                self.assertEqual(first['status'], 'WAITING', first.get('error'))
                self.assertEqual(first['payload']['interactions'][0]['id'], 'ask-1')
                body['runId'] = 'fixture-run-resume'
                body['taskSession'] = {'answer': {'interactionId': 'ask-1', 'answers': {'如何处理服务？': '保留服务'}}}
                second = invoke(body)
                self.assertEqual(second['status'], 'PRODUCED', (second.get('error'), [
                    [{'role': item.get('role'), 'content': item.get('content'), 'tool_call_id': item.get('tool_call_id')}
                     for item in request.get('messages', []) if item.get('role') != 'system'] for request in requests]))
                self.assertIn('保留服务', second['payload']['message'])
                self.assertTrue(any('保留服务' in json.dumps(item, ensure_ascii=False) for item in requests[1:]))
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
