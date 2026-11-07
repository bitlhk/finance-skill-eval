"""Python caller for the existing Jiuwen Runtime HTTP session service.

The Runtime still owns deployment, affinity, checkpoints and execution journals.
This module replaces the TypeScript HTTP/SSE client, not that service.
"""
import asyncio
import inspect
import os
from urllib.parse import quote
from uuid import uuid4

from .transport import RemoteError, bounded_json, client, sse_events

# Engineering terminal records include the complete validated workspace:
# up to 32 MiB decoded, base64 expansion, plus bounded review/receipt metadata.
# Business Launcher evidence keeps the smaller default transport boundary.
ENGINEERING_FRAME_LIMIT = 48 * 1024 * 1024


class MigrationAgentUnavailable(RemoteError):
    """Transport loss does not prove that the remote task has stopped."""


class AgentRuntimeClient:
    def __init__(self, base_url=None, access_token=None, *, transport=None):
        self.base_url = (base_url or os.getenv('FINANCE_EVAL_AGENT_RUNTIME_URL') or 'http://127.0.0.1:56363').rstrip('/')
        token = os.getenv('FINANCE_EVAL_ACCESS_TOKEN', '').strip() if access_token is None else access_token
        self.headers = {'authorization': 'Bearer ' + token} if token else {}
        self.transport = transport

    def _path(self, task_id, suffix=''):
        return self.base_url + '/internal/migration/' + quote(task_id, safe='') + suffix

    async def _request(self, method, url, *, body=None, timeout=15):
        async with client(timeout, transport=self.transport) as http:
            async with http.stream(method, url, headers=self.headers, json=body) as response:
                if not response.is_success:
                    raise RemoteError(f'Agent Runtime HTTP {response.status_code}', status=response.status_code)
                return await bounded_json(response)

    async def ready(self, task_id, attempt_id):
        value = await self._request('GET', self._path(task_id, '/ready/' + quote(attempt_id, safe='')), timeout=5)
        if type(value.get('ready')) is not bool:
            raise RemoteError('Agent Runtime returned an invalid status')
        return value['ready']

    async def instruction(self, task_id, attempt_id, request_id, text):
        await self._request('POST', self._path(task_id, '/instruction'),
                            body={'attemptId': attempt_id, 'requestId': request_id, 'text': text})

    async def cancel(self, task_id, attempt_id):
        try:
            await self._request('POST', self._path(task_id, '/cancel/' + quote(attempt_id, safe='')))
            return True
        except RemoteError as error:
            if error.status is not None:
                return False
            raise

    async def control(self, task_id, attempt_id, action, instructions=()):
        if action not in ('pause', 'resume'):
            raise ValueError('Invalid session control')
        try:
            await self._request('POST', self._path(task_id, '/' + action + '/' + quote(attempt_id, safe='')),
                                body={'instructions': list(instructions)}, timeout=125)
            return True
        except RemoteError as error:
            if error.status is not None:
                return False
            raise

    async def control_state(self, task_id, attempt_id):
        value = await self._request('GET', self._path(task_id, '/control-state/' + quote(attempt_id, safe='')), timeout=6)
        state = value.get('state')
        if state not in ('RUNNING', 'PAUSING', 'PAUSED', 'IDLE', 'UNAVAILABLE'):
            raise RemoteError('Agent Runtime 状态无效')
        return state

    async def execution_status(self, task_id, execution_id):
        value = await self._request('GET', self._path(task_id, '/execution/' + quote(execution_id, safe='') + '/status'), timeout=5)
        available, state = value.get('available'), value.get('state')
        if type(available) is not bool or (state is not None and state not in ('running', 'completed', 'interrupted', 'failed', 'missing')):
            raise RemoteError('Agent Runtime 执行状态无效')
        if state is not None and available != (state in ('running', 'completed')):
            raise RemoteError('Agent Runtime 执行状态互相矛盾')
        return {'available': available, 'state': state or ('running' if available else 'missing')}

    async def execute(self, body, task_id, *, on_activity=None):
        session = body.get('taskSession') or {}
        execution_id = session.get('executionId') or str(uuid4())
        sequence, result = 0, None
        for attempt in range(4):
            initial = attempt == 0 and session.get('reattach') is not True
            url = (self.base_url + '/v1/workspace/agents/migration/conversations/' + quote(task_id, safe='') if initial
                   else self._path(task_id, '/execution/' + quote(execution_id, safe='') + '?after=' + str(sequence)))
            try:
                async with client(None, transport=self.transport) as http:
                    async with http.stream('POST' if initial else 'GET', url, headers=self.headers,
                        **({'json': {'input': {'query': '执行迁移任务'}, 'stream': True, 'payload': body,
                                     'executionId': execution_id}} if initial else {})) as response:
                        if not response.is_success:
                            raise RemoteError(f'Agent 运行服务不可用 ({response.status_code})', status=response.status_code)
                        async for envelope in sse_events(response, frame_limit=ENGINEERING_FRAME_LIMIT):
                            if envelope.get('error'):
                                raise RemoteError('Agent 运行服务执行失败')
                            event = envelope if initial else envelope.get('record')
                            if not isinstance(event, dict):
                                continue
                            if not initial and (type(envelope.get('sequence')) is not int or envelope['sequence'] != sequence + 1):
                                raise RemoteError('Agent 运行事件顺序不连续')
                            if event.get('result') is not None:
                                result = event['result']
                            elif event.get('type') == 'result' and isinstance(event.get('content'), str):
                                result = event if body.get('roleCall') else event['content']
                            elif event.get('type') == 'error' or event.get('error'):
                                if isinstance(event.get('code'), str) and event['code'].startswith('MODEL_'):
                                    raise RemoteError(event.get('message') or '模型调用失败', code=event['code'], status=event.get('httpStatus'))
                                raise RemoteError('Agent 运行服务执行失败')
                            elif on_activity and isinstance(event.get('activity'), dict):
                                activity = event['activity']
                                if isinstance(activity.get('kind'), str) and isinstance(activity.get('label'), str):
                                    notified = on_activity(activity)
                                    if inspect.isawaitable(notified):
                                        await notified
                            sequence = sequence + 1 if initial else envelope['sequence']
                if result is not None:
                    return result
                raise RemoteError('Agent 运行服务没有返回执行结果')
            except asyncio.CancelledError:
                # Interruption is explicit; never replay POST or quietly resume.
                raise
            except Exception as error:
                if isinstance(error, RemoteError) and (error.code or '').startswith('MODEL_'):
                    raise
                if attempt == 3:
                    raise MigrationAgentUnavailable('Agent 会话连接中断，工作与检查点已保留；请核对运行状态后继续') from error
                await asyncio.sleep(0.25 * (attempt + 1))
