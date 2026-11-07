import json
import os
import sys
import threading
import unittest
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src'))
from runtime.builder_client import BuilderClient, BuilderError


class Handler(BaseHTTPRequestHandler):
    requests = []

    def log_message(self, *_args):
        pass

    def do_POST(self):
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.requests.append((self.path, self.headers.get('Authorization'), self.headers.get('Idempotency-Key'), payload))
        self.reply({'buildId': 'build-1', 'status': 'starting'})

    def do_GET(self):
        self.requests.append((self.path, self.headers.get('Authorization')))
        self.reply({'buildId': 'build-1', 'status': 'SUCCEEDED', 'result': {'status': 'SUCCEEDED'}})

    def do_DELETE(self):
        self.requests.append((self.path, self.headers.get('Authorization')))
        self.reply({'buildId': 'build-1', 'status': 'CANCELLED'})

    def reply(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


class BuilderClientTest(unittest.TestCase):
    def test_submit_poll_and_cancel(self):
        Handler.requests = []
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        client = BuilderClient(f'http://127.0.0.1:{server.server_port}/oj/', 'private-token')
        self.assertEqual(client.submit({'requestId': 'r'}, {'skills': []}, 'same-request')['status'], 'starting')
        self.assertEqual(client.get('build-1')['status'], 'SUCCEEDED')
        self.assertEqual(client.cancel('build-1')['status'], 'CANCELLED')
        self.assertEqual(Handler.requests[0], ('/oj/v1/runtime-builds', 'Bearer private-token', 'same-request',
                                               {'requirements': {'requestId': 'r'}, 'instanceRequest': {'skills': []}}))
        self.assertEqual(Handler.requests[1][0], '/oj/v1/runtime-builds/build-1')

    def test_rejects_unsafe_addresses_and_build_ids(self):
        with self.assertRaises(ValueError):
            BuilderClient('http://example.com/', 'token')
        client = BuilderClient('https://example.com/oj/', 'token')
        with self.assertRaises(ValueError):
            client.get('../other')
        with self.assertRaises(ValueError):
            client.submit({}, {}, 'bad\nkey')

    def test_command_uses_operator_credentials_without_returning_them(self):
        Handler.requests = []
        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        script = os.path.join(os.path.dirname(__file__), '..', 'src', 'runtime', 'builder_command_entry.py')
        env = {**os.environ, 'FINANCE_EVAL_BUILDER_BASE_URL': f'http://127.0.0.1:{server.server_port}/oj/',
               'FINANCE_EVAL_BUILDER_TOKEN': 'private-token'}
        request = {'action': 'submit', 'requirements': {'requestId': 'r'}, 'instanceRequest': {'skills': []}, 'idempotencyKey': 'request-1'}
        result = subprocess.run([sys.executable, '-B', script], input=json.dumps(request), capture_output=True, text=True, env=env, check=True)
        self.assertEqual(json.loads(result.stdout)['value']['buildId'], 'build-1')
        self.assertNotIn('private-token', result.stdout + result.stderr)
        self.assertEqual(Handler.requests[0][1], 'Bearer private-token')


if __name__ == '__main__':
    unittest.main()
