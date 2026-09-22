import json, os, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers
mcp = FastMCP('enterprise-demo')
from get_balance import get_balance as _get_balance
@mcp.tool()
def get_balance(account_id: str) -> dict:
    headers = get_http_headers()
    return _get_balance(account_id=account_id, user=json.loads(headers['x-user']), service_url=headers['x-service-url'], credential=headers['authorization'])

if __name__ == '__main__':
    mcp.run(transport='streamable-http', host='127.0.0.1', port=int(os.environ.get('PORT', '4330')))
