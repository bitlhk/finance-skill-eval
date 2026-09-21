"""Local business API and deterministic original-service oracle. No LLM or writes."""
import argparse
import asyncio
import importlib.util
import inspect
import json
from pathlib import Path
import re
import sys
from threading import Thread
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import types
from urllib.request import Request, urlopen
from business import api

ROOT = Path(__file__).resolve().parent


class FixtureToolResponse:
    def __init__(self, content, metadata=None, **_):
        self.content = content
        self.metadata = metadata


class FixtureToolBase:
    def __init__(self, *_, **__): pass


class FixtureToolkit:
    def __init__(self, tools=None):
        self.tools = {}
        for tool in tools or []: self.register_tool(tool)

    def register_tool(self, tool):
        self.tools[tool.name] = (tool.call, {})

    def register_tool_function(self, function, preset_kwargs=None, name=None, **_):
        self.tools[name or function.__name__] = (function, dict(preset_kwargs or {}))

    def invoke(self, name, **inputs):
        function, preset = self.tools[name]
        result = function(**inputs, **preset)
        if inspect.isawaitable(result): result = asyncio.run(result)
        if isinstance(result, FixtureToolResponse): return result.metadata['businessResult']
        return result


def install_agentscope_fixture():
    """Provide only the SDK seam owned by the original-service harness."""
    agentscope = types.ModuleType('agentscope')
    tool = types.ModuleType('agentscope.tool')
    message = types.ModuleType('agentscope.message')
    tool.Toolkit, tool.ToolBase, tool.ToolResponse = FixtureToolkit, FixtureToolBase, FixtureToolResponse
    message.TextBlock = lambda **value: value
    agentscope.tool, agentscope.message = tool, message
    sys.modules.update({'agentscope': agentscope, 'agentscope.tool': tool, 'agentscope.message': message})


def load(path):
    spec = importlib.util.spec_from_file_location(path.stem + '_fixture', path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def invoke_original(case_name, inputs, port, user):
    # The harness owns framework objects and per-run values; source ZIPs only consume them.
    install_agentscope_fixture()
    sys.modules['auth_sdk'] = load(ROOT / 'supplements/auth_sdk.py')
    source = ROOT / case_name / 'source'
    sys.path[:] = [str(source)] + [p for p in sys.path if not (p.startswith(str(ROOT)) and p.endswith('/source'))]
    for name in list(sys.modules):
        if name == 'tools' or name.startswith('tools.'): del sys.modules[name]
    context = types.SimpleNamespace(user=user, service_url=f'http://127.0.0.1:{port}', app_key='demo-app',
                                    workspace=str(ROOT / case_name / 'workspace'),
                                    department_rules={'D001': {'reserve': '100.00'}})
    if case_name == '01-expense':
        return load(source / 'scripts/check_expense.py').build_toolkit(context).invoke('check_expense', **inputs)
    toolkit = load(source / 'runtime.py').build_toolkit(context)
    if case_name == '02-balance': return toolkit.invoke('get_balance', **inputs)
    if case_name == '03-procurement':
        request = toolkit.invoke('get_request', **inputs)
        if 'error' in request: return request
        budget = toolkit.invoke('check_budget', department=request['department'], amount=request['amount'])
        supplier = toolkit.invoke('check_supplier', supplier=request['supplier'])
        reasons = ([] if budget['enough'] else ['BUDGET_EXCEEDED']) + ([] if supplier['active'] else ['SUPPLIER_INACTIVE'])
        return {'request_id': inputs['request_id'], 'approved': not reasons, 'reasons': reasons}
    return toolkit.invoke('refund_eligibility', **inputs)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_): pass

    def respond(self, value, status=200):
        content = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def do_GET(self):
        if self.path == '/health': return self.respond({'status': 'ready', 'synthetic': True})
        return self.respond({'error': 'NOT_FOUND'}, 404)

    def do_POST(self):
        try:
            length = int(self.headers.get('Content-Length', '0'))
            if length > 128000: return self.respond({'error': 'TOO_LARGE'}, 413)
            payload = json.loads(self.rfile.read(length))
            if self.path.startswith('/business/'):
                match = re.fullmatch(r'Bearer fixture:([^:]+):([^:]+)', self.headers.get('Authorization', ''))
                if not match or match[1] != 'T001': return self.respond({'error': 'UNAUTHORIZED'}, 401)
                result = api(self.path.split('/')[-1], payload, {'id': match[2], 'tenantId': match[1]})
                # Store only payload and verified identity, never auth headers.
                with self.server.calls_lock:
                    self.server.calls.append({'operation': self.path.split('/')[-1], 'payload': payload, 'userId': match[2], 'result': result})
                return self.respond(result)
            if self.path.startswith('/original/'):
                case_name = self.path.split('/')[-1]
                if case_name not in {'01-expense', '02-balance', '03-procurement', '04-refund'}: return self.respond({'error': 'NOT_FOUND'}, 404)
                # Serialized original shim: module globals never leak between concurrent executions.
                with self.server.original_lock:
                    result = invoke_original(case_name, payload['input'], self.server.server_port, payload.get('user', {'id': 'U001', 'tenantId': 'T001'}))
                return self.respond({'data': {'businessResult': result}, 'meta': {'mode': 'deterministic-original-workflow'}})
            return self.respond({'error': 'NOT_FOUND'}, 404)
        except (ValueError, KeyError, TypeError): return self.respond({'error': 'INVALID_REQUEST'}, 400)


def make_server(port=0):
    from threading import Lock
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    server.calls, server.calls_lock, server.original_lock = [], Lock(), Lock()
    return server


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, default=4327)
    args = parser.parse_args()
    server = make_server(args.port)
    print(f'Fixture APIs: http://127.0.0.1:{server.server_port}', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()
