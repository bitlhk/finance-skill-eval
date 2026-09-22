from tools.http_client import RuntimeContext, request_json
def check_supplier(supplier: str, context: RuntimeContext) -> dict:
    return request_json('supplier', {'supplier': supplier}, context)
