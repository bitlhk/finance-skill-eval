"""Register executable delivery facts without imposing a format on Agent discussion."""
import json
from pathlib import Path
from uuid import uuid4

import jsonschema
from openjiuwen.core.foundation.tool import LocalFunction, ToolCard


_TEXT = {'type': 'string', 'minLength': 1}
_SERVICES = {'type': 'array', 'maxItems': 20, 'items': {
    'type': 'object', 'additionalProperties': False,
    'properties': {'toolNames': {'type': 'array', 'minItems': 1, 'items': _TEXT},
                   'filePaths': {'type': 'array', 'minItems': 1, 'items': _TEXT},
                   'start': {'type': 'array', 'minItems': 1, 'maxItems': 100, 'items': _TEXT},
                   'prepare': {'type': 'array', 'maxItems': 100, 'items': {'type': 'string'}}},
    'required': ['toolNames', 'filePaths', 'start']}}
_TOOLS = {'type': 'array', 'maxItems': 100, 'items': {
    'type': 'object', 'additionalProperties': False,
    'properties': {'toolId': _TEXT, 'form': {'enum': ['MCP', 'CLI', 'SCRIPT']},
                   'entrypoint': {**_TEXT, 'description': 'MCP 填对应 services.toolNames 中的实际工具名，不是 Python 模块或文件路径；CLI/SCRIPT 填实际命令或脚本入口。'},
                   'files': {'type': 'array', 'minItems': 1, 'items': _TEXT},
                   'invocation': _TEXT, 'configuration': _TEXT},
    'required': ['toolId', 'form', 'entrypoint', 'files', 'invocation', 'configuration']}}
DELIVERY_TOOLS_SCHEMA = {'type': 'object', 'additionalProperties': False,
                         'properties': {'services': _SERVICES, 'tools': _TOOLS},
                         'required': ['services', 'tools']}


def validate_delivery_tools(value, candidate):
    jsonschema.validate(value, DELIVERY_TOOLS_SCHEMA)
    candidate = Path(candidate).resolve()
    for item in [*value['services'], *value['tools']]:
        for name in item.get('filePaths', item.get('files', [])):
            if '\\' in name or ':' in name or any(part in ('', '.', '..') for part in name.split('/')):
                raise ValueError('交付文件路径必须相对候选工作区')
            file = (candidate / name).resolve()
            if candidate not in file.parents or not file.is_file():
                raise ValueError('交付文件不存在：' + name)
    names = [name for service in value['services'] for name in service['toolNames']]
    ids = [tool['toolId'] for tool in value['tools']]
    if len(names) != len(set(names)) or len(ids) != len(set(ids)):
        raise ValueError('交付工具标识或 MCP 工具名称重复')
    for tool in value['tools']:
        if tool['form'] == 'MCP' and tool['entrypoint'] not in names:
            raise ValueError('MCP 工具 ' + tool['toolId'] + ' 的 entrypoint=' + tool['entrypoint']
                             + ' 未匹配 services.toolNames；请填写实际 MCP 工具名，可用：' + ', '.join(names))
    return value


def build_delivery_tools_tool(conversation, session_id, attempt_id, candidate):
    async def register_delivery_tools(services, tools):
        try:
            value = validate_delivery_tools({'services': services, 'tools': tools}, candidate)
        except (ValueError, jsonschema.ValidationError) as error:
            return {'accepted': False, 'reason': str(error).split('\n')[0][:1000]}
        await conversation.append(session_id, 'delivery-tools:' + uuid4().hex, 'delivery_tools',
                                  {'attemptId': attempt_id, **value})
        return {'accepted': True, 'note': '已登记实际交付入口；仍需在目标 Runtime 验证，不代表调用或验收通过。'}
    return LocalFunction(ToolCard(id='migration-register-delivery-tools', name='register_delivery_tools',
        description='新增、修改或移除工具后登记完整的当前工具清单。MCP 填实际服务启动命令和文件；CLI/Script 填调用说明。此工具只登记运行事实，不执行安装，不替代测试；迁移方案仍用自然语言说明。',
        input_params=DELIVERY_TOOLS_SCHEMA), register_delivery_tools)


def build_delivery_tools_query(conversation, session_id, attempt_id, candidate, published=None):
    async def query_delivery_tools():
        current = await latest_delivery_tools(conversation, session_id, attempt_id, candidate)
        if current is not None:
            return {'registered': True, 'source': 'CURRENT_ATTEMPT', **current}
        if published is not None:
            try:
                value = validate_delivery_tools(published, candidate)
                return {'registered': True, 'source': 'PUBLISHED_CANDIDATE', **value,
                    'note': '原已发布版本的入口声明，不代表当前文件已验证。'}
            except (ValueError, jsonschema.ValidationError):
                pass
        return {'registered': False, 'source': 'NONE', 'services': [], 'tools': [],
            'note': '尚无有效登记；已获授权的工具方案可直接登记，无需用户确认平台内部状态。'}
    return LocalFunction(ToolCard(id='migration-query-delivery-tools', name='query_delivery_tools',
        description='查询当前回合和已发布版本的工具入口登记事实。用于核对是否已登记，而非让用户猜测平台内部状态；登记记录不代表运行通过。',
        input_params={'type': 'object', 'properties': {}}), query_delivery_tools)


async def latest_delivery_tools(conversation, session_id, attempt_id, candidate):
    # Read the existing durable event store so ask_user/restart does not lose registration.
    import aiosqlite
    async with aiosqlite.connect(conversation.path) as db:
        cursor = await db.execute("SELECT payload FROM events WHERE session_id=? AND kind='delivery_tools' ORDER BY sequence DESC", (session_id,))
        for row in await cursor.fetchall():
            value = json.loads(row[0])
            if value.pop('attemptId', None) == attempt_id:
                return validate_delivery_tools(value, candidate)
    return None
