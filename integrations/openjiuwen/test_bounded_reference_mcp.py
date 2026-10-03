"""Real TCP tests; every child is isolated and killed/reaped by its owning test."""
import concurrent.futures
import hashlib
import importlib.metadata
import json
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
import unittest

import httpx

ROOT = Path(__file__).resolve().parent
HEADERS = {'Accept': 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-06-18'}
INIT = {'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
    'protocolVersion': '2025-06-18', 'capabilities': {},
    'clientInfo': {'name': 'bounded-source-test', 'version': '1'}}}


def child(port, ledger):
    import asyncio
    import uvicorn
    from integrations.openjiuwen.bounded_reference_mcp import BoundedMcpApp
    from integrations.openjiuwen.reference_mcp import mcp
    app = mcp.http_app(path='/mcp', stateless_http=True, json_response=True)

    async def faults(scope, receive, send):
        if scope['type'] != 'http':
            return await app(scope, receive, send)
        mode = dict(scope['headers']).get(b'x-test-fault')
        if mode in (b'hold', b'stubborn'):
            with open(ledger + '.started', 'a') as output:
                output.write('started\n')
            while True:
                try:
                    await asyncio.sleep(3600)
                except asyncio.CancelledError:
                    if mode != b'stubborn':
                        raise
        if mode == b'after-headers':
            await send({'type': 'http.response.start', 'status': 200, 'headers': []})
            await asyncio.sleep(3600)
        if mode in (b'oversize', b'stateful'):
            headers = [(b'mcp-session-id', b'not-an-owned-session')] if mode == b'stateful' else []
            await send({'type': 'http.response.start', 'status': 200, 'headers': headers})
            await send({'type': 'http.response.body', 'body': b'x' * 262145})
            return
        await app(scope, receive, send)

    def observe(event):
        with open(ledger, 'a') as output:
            output.write(json.dumps(event)+'\n')
    uvicorn.run(BoundedMcpApp(faults, timeout=.6, grace=.3, concurrency=2, observe=observe),
                host='127.0.0.1', port=int(port), access_log=False, log_level='critical',
                timeout_graceful_shutdown=1)


class BoundedReferenceTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        self.url = f'http://127.0.0.1:{port}/mcp'
        self.log = (self.folder/'server.log').open('w')
        self.addCleanup(self.log.close)
        self.process = subprocess.Popen([sys.executable, '-m',
            'integrations.openjiuwen.test_bounded_reference_mcp', '--child', str(port),
            str(self.folder/'events.jsonl')], cwd=ROOT.parents[1], stdout=self.log, stderr=self.log)
        self.addCleanup(self.stop_child)
        for _ in range(150):
            if self.process.poll() is not None:
                self.fail((self.folder/'server.log').read_text())
            try:
                with socket.create_connection(('127.0.0.1', port), timeout=.1):
                    return
            except OSError:
                time.sleep(.03)
        self.fail('SOURCE_DID_NOT_START')

    def stop_child(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=3)

    def post(self, body=INIT, fault=None, **kwargs):
        headers = {**HEADERS, **({'x-test-fault': fault} if fault else {})}
        return httpx.post(self.url, json=body, headers=headers, timeout=3, **kwargs)

    def events(self):
        path = self.folder/'events.jsonl'
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def assert_usable(self):
        response = self.post()
        self.assertEqual(response.status_code, 200)
        self.assertNotIn('mcp-session-id', response.headers)
        listing = self.post({'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'})
        self.assertEqual(len(listing.json()['result']['tools']), 16)
        for i, name in enumerate(('wind_stock_data', 'wind_financial_docs')):
            result = self.post({'jsonrpc': '2.0', 'id': 3+i, 'method': 'tools/call',
                'params': {'name': name, 'arguments': {'reference': 'DEMO001'}}})
            self.assertEqual(result.status_code, 200)
            body = result.json()['result']
            self.assertFalse(body.get('isError', False), body)
            self.assertIn('DEMO001', json.dumps(body))
        self.assertEqual(self.events()[-1]['active'], 0)

    def test_actual_source_and_sessionless_requests(self):
        self.assert_usable()
        self.assertEqual(httpx.get(self.url, timeout=3).status_code, 405)
        self.assertEqual(httpx.delete(self.url, timeout=3).status_code, 405)
        response = httpx.post(self.url, json=INIT, headers={**HEADERS, 'Mcp-Session-Id': 'shared'}, timeout=3)
        self.assertEqual(response.status_code, 400)

    def test_deadline_and_other_requests_survive(self):
        response = self.post(fault='hold')
        self.assertEqual(response.status_code, 504)
        self.assertEqual(self.events()[-1]['outcome'], 'TIMEOUT')
        self.assertEqual(self.events()[-1]['active'], 0)
        self.assert_usable()

    def test_disconnected_response_has_bounded_lifetime(self):
        with httpx.stream('POST', self.url, json=INIT,
                headers={**HEADERS, 'x-test-fault': 'after-headers'}, timeout=3) as response:
            self.assertEqual(response.status_code, 200)
        deadline = time.monotonic()+2
        while not self.events() and time.monotonic()<deadline:
            time.sleep(.02)
        self.assertEqual(self.events()[-1]['active'], 0)
        self.assertIn(self.events()[-1]['outcome'], ('TIMEOUT', 'CANCELLED'))
        self.assert_usable()

    def test_concurrency_is_rejected_not_queued(self):
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as workers:
            requests = [workers.submit(self.post, INIT, 'hold') for _ in range(2)]
            started = self.folder/'events.jsonl.started'
            deadline = time.monotonic()+2
            while (not started.exists() or len(started.read_text().splitlines()) < 2) and time.monotonic() < deadline:
                time.sleep(.005)
            self.assertTrue(started.exists())
            self.assertEqual(len(started.read_text().splitlines()), 2)
            response = self.post()
            self.assertEqual(response.status_code, 429)
            self.assertEqual([f.result(timeout=3).status_code for f in requests], [504, 504])
        self.assert_usable()

    def test_oversized_and_stateful_responses_fail_without_poisoning_source(self):
        with self.assertRaises(httpx.RemoteProtocolError):
            self.post(fault='oversize')
        self.assertEqual(self.events()[-1]['outcome'], 'RESPONSE_SIZE')
        self.assertEqual(self.post(fault='stateful').status_code, 502)
        self.assertEqual(self.events()[-1]['outcome'], 'STATEFUL_RESPONSE')
        self.assert_usable()

    def test_oversized_request_rejected(self):
        response = httpx.post(self.url, content=b'x'*65537, headers=HEADERS, timeout=3)
        self.assertEqual(response.status_code, 413)
        self.assert_usable()

    def test_uncooperative_child_fails_closed_with_bounded_exit(self):
        started = time.monotonic()
        with self.assertRaises(httpx.RemoteProtocolError):
            self.post(fault='stubborn')
        self.assertEqual(self.process.wait(timeout=2), 70)
        self.assertLess(time.monotonic()-started, 2.5)


def test_identity():
    """Test-only identity capture; a deployed source requires reviewed pins."""
    manifest = {'schemaVersion': 'finance.synthetic-mcp-source.v1', 'mode': 'STATELESS_BOUNDED',
                    'files': {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in
                        ('bounded_reference_mcp.py', 'reference_mcp.py', 'role_fixtures.py', 'role-fixtures.json')},
                    'dependencies': {}}
    for package in ('mcp', 'fastmcp', 'anyio', 'starlette', 'uvicorn'):
        distribution = importlib.metadata.distribution(package)
        manifest['dependencies'][package] = {'version': distribution.version, 'pythonFilesSha256': {
            str(p): hashlib.sha256(distribution.locate_file(p).read_bytes()).hexdigest()
            for p in distribution.files if str(p).endswith('.py')}}
    return manifest


class SourceIdentityTest(unittest.TestCase):
    def test_exact_sources_dependencies_and_mode_are_pinned(self):
        from integrations.openjiuwen.bounded_reference_mcp import verify_identity
        manifest = test_identity()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'identity.json'
            path.write_text(json.dumps(manifest))
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(verify_identity(path, digest), digest)
            with self.assertRaisesRegex(ValueError, 'SOURCE_IDENTITY_NOT_PINNED'):
                verify_identity(path, '0'*64)
            for category, key, value in [('files', 'reference_mcp.py', '0'*64),
                                         ('dependencies', 'mcp', {'version': '0', 'pythonFilesSha256': {}})]:
                original = manifest[category][key]
                manifest[category][key] = value
                path.write_text(json.dumps(manifest))
                with self.assertRaisesRegex(ValueError, 'SOURCE_.*CHANGED'):
                    verify_identity(path, hashlib.sha256(path.read_bytes()).hexdigest())
                manifest[category][key] = original
            manifest['mode'] = 'STATEFUL'
            path.write_text(json.dumps(manifest))
            with self.assertRaisesRegex(ValueError, 'SOURCE_IDENTITY_INVALID'):
                verify_identity(path, hashlib.sha256(path.read_bytes()).hexdigest())


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--child':
        child(sys.argv[2], sys.argv[3])
    elif len(sys.argv) > 1 and sys.argv[1] == '--identity':
        with Path(sys.argv[2]).open('x') as output:
            json.dump(test_identity(), output, sort_keys=True)
    else:
        unittest.main()
