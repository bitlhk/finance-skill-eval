from tools.http_client import RuntimeContext, request_json

def get_balance(account_id: str, context: RuntimeContext) -> dict:
    return request_json('balance', {'account_id': account_id}, context)
