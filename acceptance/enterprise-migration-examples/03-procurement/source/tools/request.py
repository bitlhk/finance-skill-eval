from tools.http_client import RuntimeContext, request_json
def get_request(request_id: str, context: RuntimeContext) -> dict:
    return request_json('request', {'request_id': request_id}, context)
