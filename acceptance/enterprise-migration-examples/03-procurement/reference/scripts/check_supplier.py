from http_client import request_json
def check_supplier(supplier: str, user: dict, service_url: str, credential: str) -> dict:
    return request_json('supplier', {'supplier': supplier}, service_url, credential)

if __name__ == '__main__':
    import sys, json
    print(json.dumps(check_supplier(**json.load(sys.stdin))))
