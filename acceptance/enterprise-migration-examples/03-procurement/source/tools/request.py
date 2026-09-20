from tools.http_client import request_json
def get_request(request_id: str) -> dict:
    return request_json('request', {'request_id': request_id})
