"""Private Agent service started by Jiuwen Runtime's process deployer."""
import argparse
import asyncio
import hmac
import os

import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse
from .migration_runtime import MigrationHandler
from agent_runtime.domain.context import ServeRequest

app = FastAPI()
handler = MigrationHandler()


@app.middleware('http')
async def authorize(request: Request, call_next):
    token = os.environ.get('FINANCE_EVAL_ACCESS_TOKEN', '').strip()
    if token and not hmac.compare_digest(request.headers.get('authorization', ''), 'Bearer ' + token):
        return JSONResponse({'error': 'Unauthorized'}, status_code=401)
    if not token and (not request.client or request.client.host not in ('127.0.0.1', '::1')):
        return JSONResponse({'error': 'Local access only'}, status_code=403)
    return await call_next(request)


@app.get('/ready/{session_id}/{attempt_id}')
async def ready(session_id: str, attempt_id: str):
    return {'ready': handler.ready(session_id, attempt_id)}


@app.post('/instruction/{session_id}')
async def instruction(session_id: str, request: Request):
    data = await request.json()
    try:
        await handler.steer(session_id, data['attemptId'], data['requestId'], data['text'])
    except (KeyError, ValueError, RuntimeError, asyncio.TimeoutError):
        return JSONResponse({'error': 'Session is not ready'}, status_code=409)
    return {'accepted': True}


@app.post('/cancel/{session_id}/{attempt_id}')
async def cancel(session_id: str, attempt_id: str):
    if not await handler.cancel(session_id, attempt_id):
        return JSONResponse({'error': 'Session is not running'}, status_code=409)
    return {'accepted': True}


@app.post('/{action}/{session_id}/{attempt_id}')
async def pause_or_resume(action: str, session_id: str, attempt_id: str, request: Request):
    if action not in ('pause', 'resume'):
        return JSONResponse({'error': 'Unknown control'}, status_code=404)
    try:
        data = await request.json()
    except ValueError:
        data = {}
    instructions = data.get('instructions', []) if isinstance(data, dict) else None
    if not isinstance(instructions, list) or len(instructions)>100 or any(not isinstance(item,str) or not item.strip() or len(item)>16000 for item in instructions):
        return JSONResponse({'error': 'Invalid instruction'}, status_code=400)
    accepted = await handler.pause(session_id, attempt_id) if action == 'pause' else await handler.resume(session_id, attempt_id, instructions)
    if not accepted:
        return JSONResponse({'error': 'Session is not in the required state'}, status_code=409)
    return {'accepted': True}


@app.get('/control-state/{session_id}/{attempt_id}')
async def control_state(session_id: str, attempt_id: str):
    return {'state': await handler.control_state(session_id, attempt_id)}


@app.websocket('/invoke')
async def invoke(socket: WebSocket):
    token = os.environ.get('FINANCE_EVAL_ACCESS_TOKEN', '').strip()
    if token and not hmac.compare_digest(socket.headers.get('authorization', ''), 'Bearer ' + token):
        await socket.close(code=1008)
        return
    if not token and (not socket.client or socket.client.host not in ('127.0.0.1', '::1')):
        await socket.close(code=1008)
        return
    await socket.accept()
    pending = set()
    send_lock = asyncio.Lock()

    async def send(value):
        async with send_lock:
            await socket.send_json(value)

    async def execute(message):
        identity = message.get('request_id')
        try:
            request = ServeRequest.of_text('执行迁移任务', conversation_id=message['session_id'],
                metadata={ServeRequest.REQUEST_BODY_META_KEY: {'payload': message['payload']}})
            async for chunk in handler.stream_query(request):
                await send({'request_id': identity, 'record': chunk.data.get('record')})
        except Exception as error:
            from pathlib import Path
            from traceback import extract_tb
            from .operational_logging import event
            event('migration_instance_failed', lastErrorType=type(error).__name__,
                  reason=' > '.join(f'{Path(frame.filename).name}:{frame.lineno}'
                                    for frame in extract_tb(error.__traceback__)[-8:]))
            await send({'request_id': identity, 'error': 'Agent 实例执行失败', 'errorType': type(error).__name__})
        finally:
            await send({'request_id': identity, 'completed': True})

    try:
        while True:
            message = await socket.receive_json()
            if not isinstance(message, dict):
                continue
            if message.get('type') == 'steer':
                try:
                    await handler.steer(message['session_id'], message['attempt_id'],
                                        message['request_id'], message['text'])
                    await send({'request_id': message['request_id'], 'accepted': True, 'completed': True})
                except Exception:
                    await send({'request_id': message.get('request_id'), 'error': '会话暂时无法接收输入', 'completed': True})
                continue
            task = asyncio.create_task(execute(message))
            pending.add(task)
            task.add_done_callback(pending.discard)
    except WebSocketDisconnect:
        pass
    finally:
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, required=True)
    args = parser.parse_args()
    uvicorn.run(app, host='127.0.0.1', port=args.port, log_level='warning')
