"""MCP inspection and validation through the installed protocol SDK."""
import asyncio
from contextlib import asynccontextmanager
from datetime import timedelta
from time import monotonic

from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client

from .transport import client


@asynccontextmanager
async def session(endpoint, headers=None):
    async with client(12, headers=headers or {}) as http:
        async with streamable_http_client(endpoint, http_client=http) as (read, write, _):
            async with ClientSession(read, write, read_timeout_seconds=timedelta(seconds=12)) as active:
                initialized = await active.initialize()
                yield active, initialized


async def inspect(endpoint, headers=None, *, tool_name=None, arguments=None):
    started = monotonic()
    result = {'status': 'failed', 'protocolVersion': None, 'serverName': None, 'tools': [], 'error': None}
    try:
        async with asyncio.timeout(40):
            async with session(endpoint, headers) as (active, initialized):
                result.update(protocolVersion=initialized.protocolVersion, serverName=initialized.serverInfo.name)
                cursor, seen = None, set()
                while True:
                    page = await active.list_tools(cursor=cursor)
                    result['tools'].extend(tool.model_dump(mode='json', exclude_none=True) for tool in page.tools)
                    cursor = page.nextCursor
                    if not cursor:
                        break
                    if cursor in seen or len(result['tools']) > 10000:
                        raise ValueError('Invalid MCP tools pagination')
                    seen.add(cursor)
                if tool_name is not None:
                    called = await active.call_tool(tool_name, arguments or {})
                    result['callResult'] = called.model_dump(mode='json', exclude_none=True)
                result['status'] = 'ready'
    except Exception as error:
        # Protocol exceptions can carry remote payloads or credentials.
        result.update(status='failed', error=f'MCP inspection failed ({type(error).__name__})', tools=[])
    result['elapsedMs'] = round((monotonic() - started) * 1000)
    return result
