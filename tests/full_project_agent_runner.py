"""Test-side observability adapter around the unmodified project's actual HTTP API.

Executed in its existing AgentScope dependency container, from an instance copy.
Does not substitute a model, tool, business service, or Agent implementation.
"""
import asyncio
import inspect
import json
import os
from pathlib import Path
import socket
import sys
import threading
import time
import uuid

import httpx
import uvicorn

sys.path.insert(0, str(Path.cwd()))


def serve(app):
    sock = socket.socket()
    sock.bind(('127.0.0.1', 0))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level='error'))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [sock]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 20
    while not server.started:
        if not thread.is_alive() or time.monotonic() > deadline:
            raise RuntimeError('Original Agent HTTP entry did not become ready')
        time.sleep(.05)
    return server, thread, f'http://127.0.0.1:{port}'


def main():
    request = json.load(sys.stdin)
    from app.config import settings
    binding = request.pop('trustedModelBinding', None)
    if binding:
        # Keep the original dedicated vision configuration when changing the
        # Agent's text model; this is ordinary runtime configuration, not edits
        # to the supplied Agent's code or business tools.
        settings.MULTI_MODEL_NAME = settings.MULTI_MODEL_NAME or settings.OPENAI_MODEL
        settings.MULTI_MODEL_BASE_URL = settings.MULTI_MODEL_BASE_URL or settings.OPENAI_BASE_URL
        settings.MULTI_MODEL_API_KEY = settings.MULTI_MODEL_API_KEY or settings.OPENAI_API_KEY
        settings.OPENAI_MODEL = binding['upstreamModelId']
        settings.OPENAI_BASE_URL = binding['baseUrl'].rstrip('/').removesuffix('/chat/completions')
        settings.OPENAI_API_KEY = binding['apiKey']
    settings.AGENT_DB_PATH = Path.cwd() / '.acceptance-sessions.sqlite3'
    settings.SKILLS_DIR = Path.cwd() / 'skills'
    settings.IMAGE_ROOT = Path('/acceptance/business/uploads')
    settings.MODEL_TIMEOUT_SECONDS = 240
    from app import main as original
    build_toolkit = original.build_toolkit
    captured = []

    def observed_toolkit(config, user_id, events=None):
        toolkit = build_toolkit(config, user_id, events)
        invoke = toolkit.call_tool_function

        async def observed_stream(call):
            started, last, status = time.monotonic(), None, 'completed'
            record = {'name': call['name'], 'call_id': call['id'], 'input': call.get('input', {})}
            try:
                stream = invoke(call)
                if inspect.isawaitable(stream):
                    stream = await stream
                async for result in stream:
                    last = result
                    yield result
            except Exception as error:
                record['error'], status = type(error).__name__, 'failed'
                raise
            finally:
                record.update(status=status, duration_ms=round((time.monotonic() - started) * 1000),
                              content=getattr(last, 'content', None))
                captured.append(record)
                with Path('.acceptance-tool-progress.jsonl').open('a', encoding='utf-8') as output:
                    output.write(json.dumps({'name': record['name'], 'status': status, 'durationMs': record['duration_ms']}) + '\n')
        async def observe(call):
            # AgentScope's decorated API is awaited to obtain its generator.
            return observed_stream(call)
        toolkit.call_tool_function = observe
        return toolkit

    original.build_toolkit = observed_toolkit
    build_agent = original.build_agent
    generation = {k: v for k, v in request.get('generation', {}).items() if k != 'schemaVersion'}
    actual_generation = {'temperature': 0, 'max_tokens': 4000, **generation}
    def configured_agent(*args, **kwargs):
        agent = build_agent(*args, **kwargs)
        agent.model.generate_kwargs.update(actual_generation)
        agent.model.generate_kwargs['extra_body'] = (binding.get('extraBody', {}) if binding else
            {'enable_thinking': False, 'presence_penalty': 1.5})
        async def request_started(value):
            body = json.loads(value.content)
            summary = {'event': 'model-request', 'timestamp': time.time(), 'messageCount': len(body.get('messages', [])),
                       'characters': len(value.content), 'max_tokens': body.get('max_tokens'), 'enable_thinking': body.get('enable_thinking'),
                       'tools': [(t.get('function') or {}).get('name') for t in body.get('tools', [])]}
            with Path('.acceptance-model-progress.jsonl').open('a', encoding='utf-8') as output:
                output.write(json.dumps(summary) + '\n')
        async def response_received(value):
            with Path('.acceptance-model-progress.jsonl').open('a', encoding='utf-8') as output:
                output.write(json.dumps({'event': 'model-response', 'timestamp': time.time(), 'status': value.status_code}) + '\n')
        agent.model.client._client.event_hooks['request'].append(request_started)
        agent.model.client._client.event_hooks['response'].append(response_received)
        return agent
    original.build_agent = configured_agent
    server, thread, url = serve(original.create_app(settings))
    turns, records = [], []
    try:
        headers = {'Authorization': 'Bearer ' + settings.AGENT_API_KEY, 'X-User-Id': request.get('userId', 'U001')}
        with httpx.Client(base_url=url, headers=headers, timeout=900) as client:
            client.get('/ready').raise_for_status()
            response = client.post('/v1/sessions')
            response.raise_for_status()
            sid = response.json()['id']
            for index, turn in enumerate(request.get('turns') or [{'query': request['query']} ]):
                start = len(captured)
                response = client.post('/v1/chat', json={'session_id': sid, 'request_id': str(uuid.uuid4()), 'message': turn['query']})
                response.raise_for_status()
                value = response.json()
                observed = captured[start:]
                state = httpx.get(os.environ['ACCEPTANCE_FIXTURE_URL'] + '/fixture/state', timeout=10).json()
                turns.append({'index': index, 'query': turn['query'], 'output': value['reply'], 'cards': value.get('cards', []),
                              'toolNames': [event['name'] for event in observed if event['status'] == 'completed'], 'state': state})
                records.append({'id': f'user-{index}', 'kind': 'message', 'role': 'user', 'input': turn['query']})
                for event_index, event in enumerate(observed):
                    records.append({'id': f'tool-{index}-{event_index}', 'kind': 'tool', 'callId': f'{index}-{event["call_id"]}',
                        'name': event['name'], 'status': event['status'], 'input': event['input'], 'output': event['content'],
                        'durationMs': event['duration_ms'], **({'error': event['error']} if event.get('error') else {})})
                # Cards are delivered in a separate real HTTP response field.
                # Preserve that native response too: checking only reply would
                # incorrectly turn a displayed card into missing evidence.
                records.extend([{'id': f'http-response-{index}', 'kind': 'event', 'name': 'agent_http_response', 'data': value},
                    {'id': f'assistant-{index}', 'kind': 'message', 'role': 'assistant', 'output': value['reply']},
                    {'id': f'state-{index}', 'kind': 'event', 'name': 'business_state_after_turn', 'data': state}])
            client.delete('/v1/sessions/' + sid).raise_for_status()
        result = {'sessionId': sid, 'turns': turns, 'modelId': settings.OPENAI_MODEL, 'generation': actual_generation,
                  'process': {'schemaVersion': 'finance.runtime-process.v1', 'status': 'PARTIAL', 'scopes': ['tools', 'messages', 'events'],
                              'reason': 'Actual HTTP session and Toolkit calls captured; model internals are not collected', 'records': records}}
        Path('.acceptance-result.json').write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
        print(json.dumps({'resultFile': '.acceptance-result.json', 'turns': len(turns)}), flush=True)
    finally:
        server.should_exit = True
        thread.join(10)


if __name__ == '__main__':
    main()
