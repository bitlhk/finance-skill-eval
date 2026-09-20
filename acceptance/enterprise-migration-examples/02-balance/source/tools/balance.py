from typing import TypedDict
from tools.http_client import request_json

class User(TypedDict):
    id: str
    tenantId: str

def get_balance(account_id: str) -> dict:
    return request_json('balance', {'account_id': account_id})
