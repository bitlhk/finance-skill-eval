"""Live integration bridge for the supplied AgentScope example; no model fixtures.

Runs only inside the driver's temporary source copy, with separate business data.
The original API's returned tool events are projected honestly as PARTIAL.
"""
import json
import os
import socket
import sys
import threading
import time
from pathlib import Path

import httpx
import uvicorn

sys.path.insert(0, str(Path.cwd()))


def serve(app, port=0):
    sock = socket.socket()
    sock.bind(('127.0.0.1', port))
    port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, log_level='error'))
    thread = threading.Thread(target=server.run, kwargs={'sockets': [sock]}, daemon=True)
    thread.start()
    deadline = time.monotonic() + 20
    while not server.started:
        if not thread.is_alive() or time.monotonic() > deadline:
            raise RuntimeError('Local service failed to start')
        time.sleep(.05)
    return server, thread, f'http://127.0.0.1:{port}'


request = json.load(sys.stdin)
from app.config import settings
from services.meetingroom.server import app as business_app
business, business_thread, business_url = serve(business_app, int(os.environ.get('PROJECT_BUSINESS_PORT', '0')))
settings.MEETINGROOM_BASE_URL = business_url
from app.main import create_app
from app.agent import skill_catalog
agent, agent_thread, agent_url = serve(create_app(settings))
try:
    headers = {'Authorization': 'Bearer ' + settings.AGENT_API_KEY, 'X-User-Id': 'U001'}
    with httpx.Client(base_url=agent_url, headers=headers, timeout=180) as client:
        session = client.post('/v1/sessions')
        session.raise_for_status()
        sid = session.json()['id']
        response = client.post('/v1/chat', json={'session_id': sid, 'message': request['query']})
        response.raise_for_status()
        value = response.json()
        client.delete('/v1/sessions/' + sid).raise_for_status()
    records = [{'id': 'runtime-context', 'kind': 'event', 'name': 'runtime_context',
                'data': {'userId': headers['X-User-Id'], 'agentEndpoint': '/v1/chat',
                         'businessBaseUrl': settings.MEETINGROOM_BASE_URL,
                         'businessCredentialConfigured': bool(settings.MEETINGROOM_API_KEY)}}]
    for index, event in enumerate(value.get('tool_calls', [])):
        # The existing API omits inputs and explicit failure state. Do not infer them.
        records.append({'id': f'event-{index}', 'kind': 'event', 'name': event['name'],
                        'durationMs': event.get('duration_ms', 0),
                        'data': {'toolName': event['name'], 'content': event.get('content', [])}})
    result = {'output': value['reply'], 'modelId': settings.OPENAI_MODEL,
              'loadedSkillPaths': [str(item['path'].resolve().relative_to(Path.cwd())).replace('\\', '/') for item in skill_catalog(settings)],
              'process': {'schemaVersion': 'finance.runtime-process.v1',
                          'status': 'PARTIAL' if records else 'UNAVAILABLE',
                          'scopes': ['events'] if records else [],
                          'reason': 'Original API returns tool events without inputs, call IDs or explicit status',
                          'records': records}}
    print(json.dumps(result, ensure_ascii=False))
finally:
    agent.should_exit = True
    business.should_exit = True
    agent_thread.join(10)
    business_thread.join(10)
