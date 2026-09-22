"""Compare actual original tools, migrated reference scripts and fixed targets; no LLM."""
import json
from pathlib import Path
import subprocess
import sys
from threading import Thread
from urllib.request import Request, urlopen
from server import ROOT, make_server


def run_script(root, name, inputs, workspace=None):
    completed = subprocess.run([sys.executable, '-B', str(root / 'reference/scripts' / (name + '.py'))],
                               input=json.dumps(inputs), text=True, capture_output=True,
                               cwd=workspace or root, timeout=10)
    if completed.returncode: raise AssertionError(completed.stderr)
    return json.loads(completed.stdout)


def migrated(root, inputs, base_url):
    common = {'user': {'id': 'U001', 'tenantId': 'T001'}, 'service_url': base_url, 'credential': 'Bearer fixture:T001:U001'}
    if root.name == '01-expense': return run_script(root, 'check_expense', inputs, root)
    if root.name == '02-balance': return run_script(root, 'get_balance', {**inputs, **common})
    if root.name == '04-refund': return run_script(root, 'refund_eligibility', {**inputs, **common})
    request = run_script(root, 'get_request', {**inputs, **common})
    budget = run_script(root, 'check_budget', {**common, 'department': request['department'], 'amount': request['amount'], 'department_rules': {'D001': {'reserve': '100.00'}}})
    supplier = run_script(root, 'check_supplier', {**common, 'supplier': request['supplier']})
    reasons = ([] if budget['enough'] else ['BUDGET_EXCEEDED']) + ([] if supplier['active'] else ['SUPPLIER_INACTIVE'])
    return {'request_id': inputs['request_id'], 'approved': not reasons, 'reasons': reasons}


def verify():
    server = make_server()
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base_url = f'http://127.0.0.1:{server.server_port}'
    report = []
    try:
        for root in sorted(ROOT.glob('0[1-4]-*')):
            for item in json.loads((root / 'targets.json').read_text(encoding='utf-8')):
                req = Request(base_url + '/original/' + root.name, data=json.dumps({'input': item['input']}).encode(), headers={'Content-Type': 'application/json'})
                before = len(server.calls)
                with urlopen(req, timeout=10) as response: original = json.load(response)['data']['businessResult']
                old_chain = [call['operation'] for call in server.calls[before:]]
                before = len(server.calls)
                reference = migrated(root, item['input'], base_url)
                new_chain = [call['operation'] for call in server.calls[before:]]
                assert original == reference == item['expected'], (item['caseId'], original, reference, item['expected'])
                assert old_chain == new_chain, (item['caseId'], old_chain, new_chain)
                report.append({'caseId': item['caseId'], 'passed': True, 'result': reference, 'businessChain': new_chain})
        # Exercise configured SDK provider and context mapping, not just hardcoded test credentials.
        from integrations.openjiuwen.runtime_context import RuntimeContext
        import asyncio
        root = ROOT / '02-balance'
        config = json.loads((root / 'runtime-config.json').read_text(encoding='utf-8'))
        config['context']['serviceUrl']['value'] = base_url
        runtime = RuntimeContext(config, {'demo_sdk': {'entrypoint': 'auth_sdk:authenticate'}}, {'DEMO_APP_KEY': 'demo-app'})
        headers = asyncio.run(runtime.request_headers('get_balance'))
        injected = {'account_id': 'ACC-001', 'user': json.loads(headers['X-User']), 'service_url': headers['X-Service-Url'], 'credential': headers['Authorization']}
        assert run_script(root, 'get_balance', injected)['balance'] == '1280.50'
        assert injected['user']['id'] == 'U001'
        print(json.dumps({'passed': len(report), 'runtimeProviderCheck': 'passed', 'cases': report}, ensure_ascii=False, indent=2))
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


if __name__ == '__main__':
    sys.path.insert(0, str(ROOT.parents[1]))
    verify()
