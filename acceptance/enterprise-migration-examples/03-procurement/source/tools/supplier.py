from tools.http_client import request_json
def check_supplier(supplier: str) -> dict:
    return request_json('supplier', {'supplier': supplier})
