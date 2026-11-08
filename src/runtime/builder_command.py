"""Single request transport for the private Builder client.

The address and credential are operator-owned environment configuration, never
model tool arguments. Each invocation terminates after one bounded request.
"""
import json
import os
import sys

from runtime.builder_client import BuilderClient


def main():
    try:
        request = json.loads(sys.stdin.readline())
        action = request['action']
        # The Builder's GET can perform its independent live-model lifecycle
        # verification before returning a result; it is not a cheap status read.
        client = BuilderClient(os.environ.get('FINANCE_EVAL_BUILDER_BASE_URL', ''),
                               os.environ.get('FINANCE_EVAL_BUILDER_TOKEN', ''),
                               timeout=360 if action == 'get' else 30)
        if action == 'submit':
            result = client.submit(request['requirements'], request['instanceRequest'], request['idempotencyKey'])
        elif action == 'get':
            result = client.get(request['buildId'])
        elif action == 'cancel':
            result = client.cancel(request['buildId'])
        else:
            raise ValueError('未知 Builder 操作')
        print(json.dumps({'ok': True, 'value': result}, ensure_ascii=True), flush=True)
    except Exception as exc:
        print(json.dumps({'ok': False, 'message': str(exc)[:1000]}, ensure_ascii=True), flush=True)


if __name__ == '__main__':
    main()
