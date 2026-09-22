from http_client import request_json
def get_request(request_id: str, user: dict, service_url: str, credential: str) -> dict:
    return request_json('request', {'request_id': request_id}, service_url, credential)

if __name__ == '__main__':
    import sys, json
    print(json.dumps(get_request(**json.load(sys.stdin))))
