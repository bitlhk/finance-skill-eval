from typing import TypedDict
from http_client import request_json as _request_json

class User(TypedDict):
    id: str
    tenantId: str

def get_balance(account_id: str, user: dict, service_url: str, credential: str) -> dict:
    def request_json(operation, payload):
        return _request_json(operation, payload, service_url, credential)
    return request_json('balance', {'account_id': account_id})

if __name__ == '__main__':
    import sys, json
    print(json.dumps(get_balance(**json.load(sys.stdin))))
