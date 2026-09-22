"""Optional real MCP transport checks in the project's pinned Runtime environment."""
import asyncio
import json
from pathlib import Path
import sys
from threading import Thread
from server import ROOT, make_server

sys.path.insert(0, str(ROOT.parents[1]))
sys.path.insert(0, str(ROOT / 'supplements'))
from integrations.openjiuwen.package_runtime import start_candidate_service
from integrations.openjiuwen.runtime_context import RuntimeContext
from fastmcp import Client
from fastmcp.client.transports import StreamableHttpTransport


async def verify():
    business = make_server()
    thread = Thread(target=business.serve_forever, daemon=True)
    thread.start()
    count = 0
    try:
        for root in sorted(ROOT.glob('0[1-4]-*')):
            config = json.loads((root / 'runtime-config.json').read_text(encoding='utf-8'))
            if root.name == '01-expense':
                config['context']['workspace']['value'] = str(root / 'workspace')
            else:
                config['context']['serviceUrl']['value'] = f'http://127.0.0.1:{business.server_port}'
            runtime = RuntimeContext(config, {'demo_sdk': {'entrypoint': 'auth_sdk:authenticate'}}, {'DEMO_APP_KEY': 'demo-app'})
            endpoint, stop = await start_candidate_service(root / 'reference', {'start': [sys.executable, '-B', 'mcp/server.py']})
            try:
                async def call(name, arguments):
                    nonlocal count
                    headers = await runtime.request_headers(name)
                    async with Client(StreamableHttpTransport(endpoint, headers=headers)) as client:
                        cards = await client.list_tools()
                        card = next(card for card in cards if card.name == name)
                        assert not {'user','credential','service_url','department_rules','workspace'} & set(card.inputSchema.get('properties', {}))
                        result = await client.call_tool(name, arguments)
                        assert not result.is_error
                        count += 1
                        if result.structured_content is not None: return result.structured_content
                        return json.loads(result.content[0].text)
                for item in json.loads((root / 'targets.json').read_text(encoding='utf-8')):
                    if root.name == '01-expense': result = await call('check_expense', item['input'])
                    elif root.name == '02-balance': result = await call('get_balance', item['input'])
                    elif root.name == '04-refund': result = await call('refund_eligibility', item['input'])
                    else:
                        request = await call('get_request', item['input'])
                        budget = await call('check_budget', {'department': request['department'], 'amount': request['amount']})
                        supplier = await call('check_supplier', {'supplier': request['supplier']})
                        reasons = ([] if budget['enough'] else ['BUDGET_EXCEEDED']) + ([] if supplier['active'] else ['SUPPLIER_INACTIVE'])
                        result = {'request_id': item['input']['request_id'], 'approved': not reasons, 'reasons': reasons}
                    assert result == item['expected'], (item['caseId'], result)
            finally: await stop()
        print(f'Real MCP: 12 scenarios, {count} calls passed; SDK provider and hidden context checked.')
    finally:
        business.shutdown()
        business.server_close()
        thread.join(timeout=5)


if __name__ == '__main__': asyncio.run(verify())
