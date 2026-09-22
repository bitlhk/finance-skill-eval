import os
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers
from check_expense import _check_expense

mcp = FastMCP('expense-compliance')

@mcp.tool()
def check_expense(claim_id: str) -> dict:
    workspace = get_http_headers()['x-workspace-root']
    return _check_expense(claim_id, workspace)

if __name__ == '__main__':
    mcp.run(transport='streamable-http', host='127.0.0.1', port=int(os.environ.get('PORT', '4330')))
