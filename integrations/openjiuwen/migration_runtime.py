"""Migration Agent adapter for the openJiuwen agent-runtime service SDK.

The runtime owns HTTP projection and its execution lifecycle. The platform's
existing task service remains the source of task authorization and history.
"""
from __future__ import annotations

import asyncio
import json
import hmac
import ipaddress
import inspect
import os
import re
import sys


from pathlib import Path
from typing import Any

from .operational_logging import configure_sdk_logging
configure_sdk_logging()

from agent_runtime.bootstrap.rest_app import create_rest_app
from agent_runtime.adapters.inbound.rest.mobile_bank import MobileBankChannel
from agent_runtime.domain.context import ServeRequest
from agent_runtime.domain.result import QueryChunk, QueryResponse
from fastapi import Request
from fastapi.responses import JSONResponse
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, ValidationError


class _Output:
    def __init__(self, queue: asyncio.Queue):
        self.queue = queue

    def write(self, value: str):
        for line in value.splitlines():
            if line:
                self.queue.put_nowait(json.loads(line))

    def flush(self):
        pass


class _Control:
    def __init__(self):
        self.session = None
        self.role_call = False
        self.worker_task = None

    def start(self, session):
        self.session = session

    async def close(self):
        self.session = None
        self.role_call = False


def _task_storage_allowed(payload):
    allowed_root = Path(os.environ.get('FINANCE_EVAL_DATA_DIR') or
                        Path(__file__).resolve().parents[2] / 'data').resolve()
    supplied_root = payload.get('checkpointRoot')
    try:
        return isinstance(supplied_root, str) and Path(supplied_root).resolve().is_relative_to(allowed_root)
    except (OSError, RuntimeError, ValueError):
        return False


class MigrationHandler:
    """Map existing migration execution into the runtime's AgentHandler SPI."""
    agent_id = 'migration-main'
    priority = 0

    def __init__(self, run_bundle=None):
        self._run_bundle = run_bundle
        self._active: dict[str, tuple[str, _Control]] = {}
        # CheckpointerFactory is currently global in the installed SDK. Until
        # it supports instance binding, do not let tasks replace each other's
        # checkpointer in this host.
        self._sdk_lock = asyncio.Lock()

    def is_healthy(self):
        return True

    async def start(self):
        pass

    async def stop(self):
        pass

    async def clear_session(self, conversation_id: str):
        raise RuntimeError('Task history is managed by the platform')

    async def query(self, request: ServeRequest):
        result = None
        async for item in self.stream_query(request):
            result = item.data.get('record', result)
        return QueryResponse(result=result, conversation_id=request.conversation_id)

    async def stream_query(self, request: ServeRequest):
        body = request.metadata.get(ServeRequest.REQUEST_BODY_META_KEY, {})
        payload = body.get('payload') if isinstance(body, dict) else None
        correlation = payload.get('correlation', {}) if isinstance(payload, dict) else {}
        if (not isinstance(payload, dict) or not isinstance(payload.get('taskSession'), dict)
                or correlation.get('taskId') != request.conversation_id
                or not isinstance(correlation.get('attemptId'), str)):
            raise ValueError('Migration task session and matching correlation are required')
        if self._run_bundle is None:
            if not _task_storage_allowed(payload):
                raise ValueError('Task storage is outside the configured data directory')
        if self._run_bundle is None:
            # bundle_agent currently uses script-relative imports. Keep this
            # compatibility at the application boundary, not in the SDK.
            from .environment_check import check_environment
            check_environment()
            directory = str(Path(__file__).resolve().parent)
            if directory not in sys.path:
                sys.path.insert(0, directory)
            from bundle_agent import run_bundle
            run = run_bundle
        else:
            run = self._run_bundle
        queue: asyncio.Queue[Any] = asyncio.Queue()
        control = _Control()
        async with self._sdk_lock:
            if request.conversation_id in self._active:
                raise RuntimeError('Migration session is already running')
            self._active[request.conversation_id] = (correlation['attemptId'], control)
            async def execute():
                try:
                    role_call = payload.get('roleCall')
                    if role_call is not None:
                        if not isinstance(role_call, dict) or role_call.get('role') != 'effect-review':
                            raise ValueError('Unsupported runtime role')

                        from .model_role_agent import run as run_model_role
                        timeout = role_call.get('timeoutMs', 120000)
                        if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 900000:
                            raise ValueError('Invalid review timeout')
                        control.role_call = True
                        await run_model_role(role_call, _Output(queue))
                    else:
                        await run(payload, _Output(queue), control)
                finally:
                    await control.close()
                    await queue.put(None)
            task = asyncio.create_task(execute())
            control.worker_task = task
            try:
                while (record := await queue.get()) is not None:
                    yield QueryChunk.of_chunk({'record': record})
                await task
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
                self._active.pop(request.conversation_id, None)

    async def steer(self, conversation_id: str, attempt_id: str, request_id: str, text: str):
        active = self._active.get(conversation_id)
        if not active or active[0] != attempt_id or active[1].session is None:
            raise RuntimeError('Migration session is not ready')
        await active[1].session.steer(text, request_id)

    def ready(self, conversation_id: str, attempt_id: str) -> bool:
        active = self._active.get(conversation_id)
        return bool(active and active[0] == attempt_id and active[1].session is not None)

    async def cancel(self, conversation_id: str, attempt_id: str):
        active = self._active.get(conversation_id)
        if active and active[0] == attempt_id and active[1].role_call:

            if active[1].worker_task is not None:
                active[1].worker_task.cancel()
                await asyncio.gather(active[1].worker_task, return_exceptions=True)
            return True
        if not active or active[0] != attempt_id or active[1].session is None:
            return False
        return await active[1].session.cancel()

    async def pause(self, conversation_id: str, attempt_id: str):
        active = self._active.get(conversation_id)
        if not active or active[0] != attempt_id or active[1].session is None:
            return False
        return await active[1].session.pause()

    async def resume(self, conversation_id: str, attempt_id: str, instructions=()):
        active = self._active.get(conversation_id)
        if not active or active[0] != attempt_id or active[1].session is None:
            return False
        return await active[1].session.resume(instructions)

    async def control_state(self, conversation_id: str, attempt_id: str):
        active = self._active.get(conversation_id)
        if not active or active[0] != attempt_id or active[1].session is None:
            return 'UNAVAILABLE'
        return await active[1].session.control_state()

class MigrationChannel(MobileBankChannel):
    """Expose only the platform's event payload, not framework internals."""
    name = 'migration'

    def format_event(self, result, *, agent_id, conversation_id, elapsed):
        if result.type == QueryChunk.TYPE_CHUNK:
            return result.data.get('record')
        return super().format_event(result, agent_id=agent_id, conversation_id=conversation_id, elapsed=elapsed)


class PoolHandler:
    """Present the Runtime-managed instance pool through the existing service."""
    agent_id = 'migration-main'
    priority = 0

    def __init__(self):
        from .migration_pool import MigrationPool
        from .execution_relay import ExecutionRelay
        self.pool = MigrationPool(max_services=int(os.environ.get('FINANCE_EVAL_AGENT_MAX_SERVICES', '4')))
        data_root = Path(os.environ.get('FINANCE_EVAL_DATA_DIR') or Path(__file__).resolve().parents[2] / 'data')
        self.relay = ExecutionRelay(journal_root=data_root / 'migration-runtime')


    def is_healthy(self):
        return True

    async def start(self):
        await self.pool.start()

    async def stop(self):
        await self.relay.close()
        await self.pool.stop()

    async def clear_session(self, conversation_id):
        raise RuntimeError('Task history is managed by the platform')

    async def query(self, request):
        result = None
        async for item in self.stream_query(request):
            result = item.data.get('record', result)
        return QueryResponse(result=result, conversation_id=request.conversation_id)

    async def stream_query(self, request):
        body = request.metadata.get(ServeRequest.REQUEST_BODY_META_KEY, {})
        payload = body.get('payload') if isinstance(body, dict) else None
        execution_id = body.get('executionId') if isinstance(body, dict) else None
        correlation = payload.get('correlation', {}) if isinstance(payload, dict) else {}
        if (not isinstance(payload, dict) or correlation.get('taskId') != request.conversation_id
                or not isinstance(execution_id, str) or not execution_id or len(execution_id)>100):
            raise ValueError('Task identity does not match session')
        if not _task_storage_allowed(payload):
            yield QueryChunk.of_chunk({'record': {'result': {'status': 'FAILED',
                'error': 'Agent Runtime 与平台工作区目录配置不一致，请管理员检查 FINANCE_EVAL_DATA_DIR。'}}})
            return

        async def produce():
            async for frame in self.pool.stream(request.conversation_id, execution_id, payload):
                if frame.get('record') is not None:
                    yield frame['record']
                elif frame.get('error') or frame.get('payload', {}).get('error_code'):
                    # An explicit instance failure is a confirmed failed
                    # result, not a lost transport result. Do not forward raw
                    # exception messages, which can contain task credentials.
                    error_type = frame.get('errorType', '')
                    suffix = ('（' + error_type + '）' if isinstance(error_type, str)
                              and re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]{0,79}', error_type) else '')
                    yield {'result': {'status': 'FAILED', 'error': 'Agent 实例执行失败' + suffix}}

        self.relay.start(request.conversation_id, execution_id, payload, produce)
        async for item in self.relay.subscribe(request.conversation_id, execution_id):
            yield QueryChunk.of_chunk({'record': item['record']})

    async def ready(self, conversation_id, attempt_id):
        return await self.pool.control(conversation_id, attempt_id)

    async def steer(self, conversation_id, attempt_id, request_id, text):
        if not await self.pool.control(conversation_id, attempt_id, request_id, text):
            raise RuntimeError('Session is not ready')

    async def cancel(self, conversation_id, attempt_id):
        return await self.pool.cancel(conversation_id, attempt_id)

    async def pause(self, conversation_id, attempt_id):
        return await self.pool.transition(conversation_id, attempt_id, 'pause')

    async def resume(self, conversation_id, attempt_id, instructions=()):
        return await self.pool.transition(conversation_id, attempt_id, 'resume', instructions)

    async def control_state(self, conversation_id, attempt_id):
        return await self.pool.control_state(conversation_id, attempt_id)

class _Instruction(BaseModel):
    attemptId: str = Field(min_length=1, max_length=100)
    requestId: str = Field(min_length=1, max_length=100)
    text: str = Field(min_length=1, max_length=16000)


class _ResumeInputs(BaseModel):
    instructions: list[str] = Field(default_factory=list, max_length=100)


def create_migration_runtime(handler=None):
    from .environment_check import check_environment
    check_environment()
    handler = handler or PoolHandler()
    app = create_rest_app(handler, channel=MigrationChannel())

    @app.middleware('http')
    async def authorize(request: Request, call_next):
        # Reuse the deployment's existing access credential. With no token the
        # service is local-only, matching the existing single-workspace mode.
        token = os.environ.get('FINANCE_EVAL_ACCESS_TOKEN', '').strip()
        if token:
            supplied = request.headers.get('authorization', '')
            if not hmac.compare_digest(supplied, 'Bearer ' + token):
                return JSONResponse({'error': 'Unauthorized'}, status_code=401)
        else:
            try:
                local = bool(request.client and ipaddress.ip_address(request.client.host).is_loopback)
            except ValueError:
                local = False
            if not local:
                return JSONResponse({'error': 'Local access only'}, status_code=403)
        return await call_next(request)

    @app.get('/internal/migration/{conversation_id}/ready/{attempt_id}')
    async def ready(conversation_id: str, attempt_id: str):
        result = handler.ready(conversation_id, attempt_id)
        return {'ready': await result if inspect.isawaitable(result) else result}

    @app.get('/internal/health')
    async def health():
        return {'status': 'ready'}

    @app.get('/internal/migration/{conversation_id}/execution/{execution_id}')
    async def execution_events(conversation_id: str, execution_id: str, after: int = 0):
        relay = getattr(handler, 'relay', None)
        if relay is None or not relay.has(conversation_id, execution_id):
            return JSONResponse({'error': 'Execution is not available'}, status_code=404)
        if after < 0:
            return JSONResponse({'error': 'Invalid cursor'}, status_code=400)

        async def stream():
            try:
                async for event in relay.subscribe(conversation_id, execution_id, after):
                    yield 'data: ' + json.dumps(event, ensure_ascii=False) + '\n\n'
            except RuntimeError:
                yield 'data: {"error":"Execution is not confirmed"}\n\n'
        return StreamingResponse(stream(), media_type='text/event-stream', headers={'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no'})

    @app.get('/internal/migration/{conversation_id}/execution/{execution_id}/status')
    async def execution_status(conversation_id: str, execution_id: str):
        relay = getattr(handler, 'relay', None)
        state = relay.state(conversation_id, execution_id) if relay else 'missing'
        return {'available': state in ('running', 'completed'), 'state': state}

    @app.post('/internal/migration/{conversation_id}/instruction')
    async def instruction(conversation_id: str, value: _Instruction):
        try:
            await handler.steer(conversation_id, value.attemptId, value.requestId, value.text)
        except (RuntimeError, ValueError, asyncio.TimeoutError):
            return JSONResponse({'error': 'Session is not ready'}, status_code=409)
        return {'accepted': True}

    @app.post('/internal/migration/{conversation_id}/cancel/{attempt_id}')
    async def cancel(conversation_id: str, attempt_id: str):
        if not await handler.cancel(conversation_id, attempt_id):
            return JSONResponse({'error': 'Session is not running'}, status_code=409)
        return {'accepted': True}

    @app.post('/internal/migration/{conversation_id}/{action}/{attempt_id}')
    async def pause_or_resume(conversation_id: str, action: str, attempt_id: str, request: Request):
        if action not in ('pause', 'resume'):
            return JSONResponse({'error': 'Unknown control'}, status_code=404)
        try:
            body = await request.json()
        except ValueError:
            body = {}
        try:
            inputs = _ResumeInputs.model_validate(body)
        except ValidationError:
            return JSONResponse({'error': 'Invalid instruction'}, status_code=400)
        if any(not text.strip() or len(text)>16000 for text in inputs.instructions):
            return JSONResponse({'error': 'Invalid instruction'}, status_code=400)
        accepted = await handler.pause(conversation_id, attempt_id) if action == 'pause' else await handler.resume(conversation_id, attempt_id, inputs.instructions)
        if not accepted:
            return JSONResponse({'error': 'Session is not in the required state'}, status_code=409)
        return {'accepted': True}

    @app.get('/internal/migration/{conversation_id}/control-state/{attempt_id}')
    async def control_state(conversation_id: str, attempt_id: str):
        return {'state': await handler.control_state(conversation_id, attempt_id)}

    return app


# ASGI entry point for an Agent Runtime application instance.
app = create_migration_runtime()
