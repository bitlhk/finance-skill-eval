import json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers
mcp = FastMCP('enterprise-demo')
from get_request import get_request as _get_request
@mcp.tool()
def get_request(request_id: str) -> dict:
    headers = get_http_headers()
    return _get_request(request_id=request_id, user=json.loads(headers['x-user']), service_url=headers['x-service-url'], credential=headers['authorization'])
from check_budget import check_budget as _check_budget
@mcp.tool()
def check_budget(department: str, amount: str) -> dict:
    headers = get_http_headers()
    return _check_budget(department=department, amount=amount, user=json.loads(headers['x-user']), service_url=headers['x-service-url'], credential=headers['authorization'], department_rules=json.loads(headers['x-department-rules']))
from check_supplier import check_supplier as _check_supplier
@mcp.tool()
def check_supplier(supplier: str) -> dict:
    headers = get_http_headers()
    return _check_supplier(supplier=supplier, user=json.loads(headers['x-user']), service_url=headers['x-service-url'], credential=headers['authorization'])

if __name__ == '__main__':
    mcp.run(transport='streamable-http', host='127.0.0.1', port=int(os.environ.get('PORT', '4330')))
