"""Deployment smoke checks using native HTTP clients and published contracts."""
import argparse
import asyncio
import json
import os
from runtime.transport import client, bounded_json
from runtime.contracts import validate


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--api', required=True)
    parser.add_argument('--runtime', required=True)
    options = parser.parse_args()
    headers = {'authorization': 'Bearer ' + os.environ['FINANCE_EVAL_ACCESS_TOKEN']}
    async with client(10) as http:
        response = await http.get(options.api + '/api/health')
        if not response.is_success or response.json().get('status') != 'ready':
            raise ValueError('API_NOT_READY')
        response = await http.get(options.api + '/api/migration-tasks')
        if response.status_code != 401:
            raise ValueError('ANONYMOUS_ACCESS_NOT_BLOCKED')
        for suffix in ('/api/migration-tasks', '/api/catalog'):
            if not (await http.get(options.api + suffix, headers=headers)).is_success:
                raise ValueError('AUTHENTICATED_WORKSPACE_NOT_READY')
        async with http.stream('GET', options.runtime + '/v1/runtime-capabilities') as response:
            if not response.is_success:
                raise ValueError('RUNTIME_NOT_READY')
            validate('finance.runtime-capabilities.v1', await bounded_json(response))
        agent = os.getenv('FINANCE_EVAL_AGENT_RUNTIME_URL') or 'http://127.0.0.1:' + os.getenv('FINANCE_EVAL_AGENT_RUNTIME_PORT', '56363')
        if not (await http.get(agent.rstrip('/') + '/internal/health', headers=headers)).is_success:
            raise ValueError('AGENT_RUNTIME_NOT_READY')
    print(json.dumps({'status': 'PASSED', 'checks': ['api', 'authentication', 'workspace-catalog', 'runtime-capabilities', 'agent-runtime'], 'modelExecution': 'NOT_TESTED'}))


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception as error:
        code = str(error)
        print(json.dumps({'status': 'FAILED', 'code': code if code.isupper() and code.replace('_', '').isalnum() else 'HEALTH_CONNECTION_FAILED'}))
        raise SystemExit(1)
