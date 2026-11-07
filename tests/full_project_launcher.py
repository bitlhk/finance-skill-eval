"""Acceptance-only standard Launcher: original AgentScope entry or real Jiuwen worker.

This adapter supplies the uploaded project's existing dependency environment and
an isolated real business-state fixture. Execution/judging remain platform code.
It is not shipped as another production Runtime.
"""
import asyncio
import base64
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
import httpx

from integrations.openjiuwen.bundle_runtime import files_digest, safe_path
from runtime.contracts import validate
from tasks.values import fingerprint, workspace_digest

ROOT = Path(__file__).resolve().parents[1]
DIRECTORY = ROOT / 'artifacts' / 'full-agent-project-live'
BUSINESS = 'http://127.0.0.1:56370'
WORKER = 'http://127.0.0.1:56362'
CONTAINER = 'finance-full-project-acceptance'
app = FastAPI()
instances, keys, leases = {}, {}, {}
state_lock = asyncio.Lock()


def business_binding():
    from integrations.openjiuwen.worker import config
    return config()['models']['enterprise-model']


async def downstream(method, path, **kwargs):
    async with httpx.AsyncClient(timeout=900, trust_env=False) as client:
        response = await client.request(method, path, **kwargs)
        response.raise_for_status()
        return response.json() if response.content else {}


@app.get('/{kind}/v1/runtime-capabilities')
async def capabilities(kind: str):
    if kind == 'candidate':
        result = await downstream('GET', WORKER + '/v1/runtime-capabilities')
        result['features']['caseStateLifecycle'] = True
        return result
    return {'schemaVersion': 'finance.runtime-capabilities.v1', 'instanceSchemaVersion': 'finance.runtime-instance.v1',
        'platform': {'os': 'linux', 'arch': 'x64', 'isolation': 'docker'},
        'runtime': {'type': 'agentscope', 'version': '1.0.21'},
        'models': [{'modelId': 'enterprise-model', 'upstreamModelId': business_binding()['upstreamModelId']}], 'defaultModelId': 'enterprise-model',
        'features': {'projectExecution': True, 'processEvidence': True, 'multiTurn': True, 'caseStateLifecycle': True,
                     'toolEnvironment': False, 'streaming': False, 'inlineSecrets': False,
                     'asyncLaunch': False, 'packagedMcp': False, 'externalMcp': False},
        'nativeToolNames': ['get_meetingroom_info_by_userid', 'get_permission_meetingroom_list', 'get_meetingroom_info_list',
             'employee_info_search', 'format_meetingroom_card', 'update_room', 'cancel_meetingroom', 'apply_room', 'analyze_image'],
        'auxiliaryToolNames': ['view_text_file'],
        'limits': {'maxArchiveBytes': 8388608, 'maxFiles': 200, 'maxTimeoutMs': 900000, 'maxConcurrentInstances': 2}}


@app.post('/{kind}/v1/runtime-instances')
async def create(kind: str, request: Request):
    body = await request.json()
    validate('finance.runtime-instance.v1', body)
    key = request.headers.get('idempotency-key')
    identity = (kind, key)
    if identity in keys:
        item = instances[keys[identity]]
        if item['requestDigest'] != fingerprint(body):
            raise HTTPException(409, 'Conflicting idempotency key')
        return item['public']
    if kind == 'candidate':
        value = await downstream('POST', WORKER + '/v1/runtime-instances', json=body, headers={'idempotency-key': key})
        identifier = value['instanceId']
        value['executeEndpoint'] = '/candidate/v1/runtime-instances/' + identifier + '/execute'
    else:
        if body['secrets']['values'] or any(name.startswith('tool.env.') for name in body.get('configuration', {})):
            raise HTTPException(400, 'Source acceptance uses its isolated preconfigured environment; dynamic tool inputs are unsupported')
        files = {name: base64.b64decode(raw, validate=True) for name, raw in body.get('assets', {}).items()}
        for skill in body['skills']:
            files[skill['skillFile']] = skill['instructions'].encode()
            files.update({name: base64.b64decode(raw, validate=True) for name, raw in skill.get('files', {}).items()})
        if files_digest(files) != body['contentDigest'] or any(not safe_path(name) for name in files):
            raise HTTPException(400, 'Project files do not match declared digest')
        if not {'app/main.py', 'app/agent.py', 'services/meetingroom/server.py'} <= set(files):
            raise HTTPException(400, 'This test Launcher only executes the supplied real AgentScope project')
        identifier = 'source-instance-' + uuid.uuid4().hex[:16]
        directory = DIRECTORY / 'instances' / identifier
        for name, raw in files.items():
            target = directory / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(raw)
        public = deepcopy(body)
        public['secrets'] = {'mode': body['secrets']['mode'], 'keys': sorted(body['secrets']['values'])}
        value = {'schemaVersion': 'finance.skill-eval.runtime-instance-state.v1', 'instanceId': identifier, 'status': 'ready',
                 'executeEndpoint': '/source/v1/runtime-instances/' + identifier + '/execute', 'error': None,
                 'configurationDigest': fingerprint(public),
                 'expiresAt': (datetime.now(timezone.utc) + timedelta(hours=2)).isoformat()}
    validate('finance.skill-eval.runtime-instance-state.v1', value)
    instances[identifier] = {'public': value, 'request': body, 'requestDigest': fingerprint(body), 'kind': kind}
    keys[identity] = identifier
    return value


@app.get('/{kind}/v1/runtime-instances/{identifier}')
async def get_instance(kind: str, identifier: str):
    if identifier not in instances:
        raise HTTPException(404)
    return instances[identifier]['public']


@app.post('/{kind}/v1/runtime-instances/{identifier}/case-state')
async def case_state(kind: str, identifier: str, body: dict):
    if identifier not in instances:
        raise HTTPException(404)
    fixture_file = DIRECTORY / 'fixtures.json'
    fixtures = json.loads(fixture_file.read_text(encoding='utf-8')) if fixture_file.exists() else {
        'empty-orders': json.loads((DIRECTORY / 'business-initial.json').read_text(encoding='utf-8'))}
    initial = fixtures.get(body['fixture']['fixtureId'])
    if initial is None or body['fixture']['version'] != '1' or fingerprint(initial) != body['fixture']['initialStateDigest']:
        raise HTTPException(409, 'Unknown or mismatched isolated business fixture')
    operation = body['operationId']
    if body['phase'] == 'prepare':
        # This test fixture owns one actual database. Reject contention before
        # acquiring it: a timed-out HTTP waiter must not later orphan its lease.
        if state_lock.locked():
            raise HTTPException(409, 'Acceptance business fixture is in use; run its cases sequentially')
        await state_lock.acquire()
        leases[operation] = identifier
    elif leases.get(operation) != identifier:
        raise HTTPException(409, 'Case-state lease does not belong to this operation')
    try:
        state = await downstream('GET', BUSINESS + '/fixture/state') if body['phase'] == 'capture' else await downstream('POST', BUSINESS + '/fixture/state', json={'state': initial})
        result = {**body, 'status': 'SUCCEEDED', 'stateDigest': fingerprint(state)}
        if body['phase'] == 'capture':
            result['state'] = state
        elif result['stateDigest'] != body['fixture']['initialStateDigest']:
            raise HTTPException(409, 'Fixture initial state mismatch')
        return result
    finally:
        if body['phase'] == 'restore' and leases.pop(operation, None):
            state_lock.release()


@app.post('/{kind}/v1/runtime-instances/{identifier}/execute')
async def execute(kind: str, identifier: str, request: Request):
    body = await request.json()
    validate('finance.skill-eval.runtime-case.v1', body)
    item = instances[identifier]
    if kind == 'candidate':
        # Preserve the existing Worker's SSE, terminal evidence and execution code.
        client = httpx.AsyncClient(timeout=900, trust_env=False)
        try:
            response = await client.send(client.build_request('POST',
                WORKER + f'/v1/runtime-instances/{identifier}/execute', json=body), stream=True)
        except BaseException:
            await client.aclose()
            raise
        async def forward():
            try:
                async for chunk in response.aiter_bytes():
                    yield chunk
            finally:
                await response.aclose()
                await client.aclose()
        return StreamingResponse(forward(), status_code=response.status_code,
            headers={'content-type': response.headers['content-type']})
    directory = DIRECTORY / 'instances' / identifier
    for file in body['workspaceFiles']:
        if not safe_path(file['path']) or (directory / file['path']).exists():
            raise HTTPException(400, 'Unsafe or overlapping workspace input')
        target = directory / file['path']
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(file['content'], encoding='utf-8')
    started = asyncio.get_running_loop().time()
    process = await asyncio.create_subprocess_exec('wsl', '-d', 'Ubuntu', '-u', 'root', '--', 'docker', 'exec', '-i',
        '-w', '/acceptance/instances/' + identifier, CONTAINER, 'python', '/test-adapters/full_project_agent_runner.py',
        stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    try:
        # Internal test-adapter input from operator configuration, never from
        # the uploaded project or public case body. Secrets stay on stdin.
        payload = {**body, 'generation': item['request'].get('generation', {}), 'trustedModelBinding': business_binding()}
        stdout, stderr = await asyncio.wait_for(process.communicate(json.dumps(payload).encode()), item['request']['limits']['timeoutMs'] / 1000)
    except BaseException:
        process.kill()
        await process.wait()
        raise
    (directory / '.acceptance-process.log').write_bytes(stdout + b'\n' + stderr)
    if process.returncode:
        raise HTTPException(502, 'Original Agent HTTP execution failed; retained private instance log')
    result = json.loads((directory / '.acceptance-result.json').read_text(encoding='utf-8'))
    turns = result['turns']
    multi = bool(body.get('turns'))
    calls = [{'name': r['name'], 'status': r['status']} for r in result['process']['records'] if r['kind'] == 'tool']
    files = item['request']
    metadata = {'projectExecution': files.get('executionMode') == 'agent_project', 'contentDigest': files['contentDigest'],
        'instanceConfigurationDigest': item['public']['configurationDigest'],
        'workspaceFilesDigest': workspace_digest(body['workspaceFiles']) if body['workspaceFiles'] else None,
        'loadedSkillMembers': [{k: s[k] for k in ('id', 'skillId', 'skillFile', 'version', 'artifactSha256')} for s in files['skills']],
        'process': result['process'], 'businessTurns': turns}
    if multi:
        metadata['conversation'] = {'sessionId': result['sessionId'], 'workspaceId': identifier,
            'turns': [{'index': t['index'], 'queryDigest': fingerprint(t['query']), 'status': 'completed', 'output': t['output'],
                       'outputDigest': fingerprint(t['output']), 'toolNames': t['toolNames']} for t in turns]}
    parameters = item['request'].get('generation')
    if parameters:
        declared = {k: v for k, v in parameters.items() if k != 'schemaVersion'}
        if any(result['generation'].get(key) != value for key, value in declared.items()):
            raise HTTPException(500, 'Original model generation settings differ from the actual binding')
        metadata.update(declaredModelParameters=declared, modelGenerationHostVerified=True)
    evidence = {'runId': files['runId'], 'side': files['side'], 'caseId': body['caseId'], 'status': 'completed',
        'modelId': files['modelId'], 'skillVersion': 'frozen',
        'output': '\n\n'.join(f'Turn {index+1}:\n' + t['output'] for index, t in enumerate(turns)) if multi else turns[0]['output'],
        'elapsedMs': round((asyncio.get_running_loop().time() - started) * 1000), 'toolCalls': calls,
        'loadedSkills': [{'skillId': s['skillId'], 'version': s['version']} for s in files['skills']],
        'usage': None, 'runtimeIdentityVerified': result['modelId'] == payload['trustedModelBinding']['upstreamModelId'],
        'streamCompleted': True, 'error': None, 'metadata': metadata}
    validate('finance.skill-eval.runtime-evidence.v1', evidence)
    return evidence


@app.delete('/{kind}/v1/runtime-instances/{identifier}')
async def delete(kind: str, identifier: str):
    if kind == 'candidate':
        return await downstream('DELETE', WORKER + '/v1/runtime-instances/' + identifier)
    instances.pop(identifier, None)
    return {'cleanup': {'schemaVersion': 'finance.eval-cleanup-observation.v1', 'instanceId': identifier,
                       'observedAt': datetime.now(timezone.utc).isoformat(), 'status': 'RELEASED', 'scope': 'THIS_INSTANCE'}}
