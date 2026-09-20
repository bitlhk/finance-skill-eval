from http_client import request_json as _request_json
def get_request(request_id: str, user: dict, service_url: str, credential: str) -> dict:
    def request_json(operation, payload):
        return _request_json(operation, payload, service_url, credential)
    return request_json('request', {'request_id': request_id})

if __name__ == '__main__':
    import sys, json
    print(json.dumps(get_request(**json.load(sys.stdin))))
