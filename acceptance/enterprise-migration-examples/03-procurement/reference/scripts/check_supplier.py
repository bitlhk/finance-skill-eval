from http_client import request_json as _request_json
def check_supplier(supplier: str, user: dict, service_url: str, credential: str) -> dict:
    def request_json(operation, payload):
        return _request_json(operation, payload, service_url, credential)
    return request_json('supplier', {'supplier': supplier})

if __name__ == '__main__':
    import sys, json
    print(json.dumps(check_supplier(**json.load(sys.stdin))))
