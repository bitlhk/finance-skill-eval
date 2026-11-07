"""Native Launcher client. Instance lifecycle and business execution share one owner."""
import asyncio
import base64
import hashlib
import inspect
import json
import re
from copy import deepcopy
from urllib.parse import urlsplit, quote
from uuid import uuid4

from tasks.values import fingerprint, workspace_digest
from evaluation.process import with_process
from evaluation.case_state import with_case_state, ExecutionFailure
from .contracts import validate
from .transport import client, controlled_url, bounded_json, require_success, sse_events, RemoteError


def base_url(value):
    parsed = urlsplit(value)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise ValueError('Runtime Launcher base URL is invalid')
    if parsed.scheme == 'http' and parsed.hostname not in ('127.0.0.1', 'localhost', '::1'):
        raise ValueError('Remote Runtime Launcher requires HTTPS')
    return value.rstrip('/') + '/'


def extract_secrets(environment, provided=None):
    environment, values = deepcopy(environment), deepcopy((provided or {}).get('values', {}))
    for collection, field, prefix in [('mcpServers', 'secretHeaders', 'external-mcp'), ('candidateMcpServices', 'secretEnvironment', 'mcp')]:
        for index, service in enumerate(environment.get(collection, [])):
            bindings = {}
            for name, value in service.pop(field, {}).items():
                key = f'{prefix}.{index}.{name}'
                values[key], bindings[name] = value, key
            if bindings:
                service['secretBindings'] = bindings
    for name, field in (environment.get('runtimeToolConfig') or {}).get('context', {}).items():
        if field.get('sensitive') and 'value' in field:
            key, value = 'context.' + name, field['value']
            values[key] = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(',', ':'))
            field['value'] = {'$secret': key}
    return environment, {'mode': 'inline', 'values': values}


def observation_summary(event):
    if event['kind'] == 'output.delta':
        return None
    result = {'sequence': event['sequence'], 'kind': event['kind'], 'synthesized': event['source']['synthesized']}
    if event['source'].get('nativeEventType'):
        result['nativeEventType'] = event['source']['nativeEventType']
    payload = event['payload']
    for source, target in [('toolCallId', 'toolCallId'), ('name', 'toolName'), ('modelCallId', 'modelCallId'),
                           ('modelId', 'modelId'), ('inputDigest', 'inputDigest'), ('outputDigest', 'outputDigest')]:
        if isinstance(payload.get(source), str):
            result[target] = payload[source]
    if isinstance(payload.get('durationMs'), (int, float)):
        result['durationMs'] = payload['durationMs']
    if isinstance(payload.get('error'), dict) and isinstance(payload['error'].get('code'), str):
        result['errorCode'] = payload['error']['code']
    return result


class RuntimeLauncher:
    STATE_FIELDS = ('lease_id', 'incarnation', 'instance', 'generation', 'cleanup_observation',
                    'cleanup_receipts', 'state_receipts', 'state_supported', 'state_blocked',
                    'recovery_required', 'failed_case_id')

    def export_state(self):
        """Internal caller continuation; no process registry or credentials."""
        return {name: deepcopy(getattr(self, name)) for name in self.STATE_FIELDS}

    def restore_state(self, state):
        if not isinstance(state, dict) or set(state) - set(self.STATE_FIELDS):
            raise ValueError('Invalid Launcher continuation')
        for name, value in state.items():
            setattr(self, name, deepcopy(value))
        self.execute_url = (controlled_url(self.base_url, self.instance['executeEndpoint'])
                            if self.instance and self.instance.get('executeEndpoint') else None)

    def __init__(self, options, *, transport=None):
        self.options, self.transport = deepcopy(options), transport
        self.base_url = base_url(options['baseUrl'])
        parsed = urlsplit(self.base_url)
        self.origin = parsed.scheme + '://' + parsed.netloc
        self.adapter_id = 'runtime-launcher:' + self.origin + ':' + options['side']
        self.lease_id, self.incarnation = str(uuid4()), 0
        self.instance = self.execute_url = None
        self.generation = None
        self.cleanup_observation, self.cleanup_receipts = {'status': 'NOT_REQUESTED'}, {}
        self.state_receipts, self.state_supported, self.state_blocked = [], False, False
        self.recovery_required, self.failed_case_id = False, None
        self.execution_lock = asyncio.Lock()

    @property
    def timeout(self):
        return self.options['timeoutMs'] / 1000

    async def request(self, method, path, *, body=None, timeout=None, headers=None, allow_error=False, limit=262144):
        async with client(timeout or self.timeout, transport=self.transport) as http:
            async with http.stream(method, controlled_url(self.base_url, path),
                headers={**self.options.get('headers', {}), **(headers or {})}, **({'json': body} if body is not None else {})) as response:
                if not allow_error:
                    await require_success(response)
                return response.status_code, await bounded_json(response, limit)

    async def prepare(self, context):
        async with asyncio.timeout(self.timeout):
            parameters = self.options['model'].get('parameters', {})
            self.generation = {'schemaVersion': 'finance.eval-generation.v1', **parameters} if parameters else None
            if self.generation:
                validate('finance.runtime-instance.v1', self.generation, 'generation')
            _, caps = await self.request('GET', 'v1/runtime-capabilities')
            validate('finance.runtime-capabilities.v1', caps)
            self.state_supported = caps['features'].get('caseStateLifecycle') is True
            if caps['features'].get('processEvidence') is not True:
                raise ValueError('Runtime Launcher 必须声明 processEvidence，并在 execute 返回 metadata.process；请按公共接入手册升级适配器')
            skill_set = deepcopy(self.options.get('skillSet'))
            if skill_set is None:
                raise ValueError('Runtime 启动需要 Skill 集合')
            if skill_set.get('executionMode') == 'agent_project' and caps['features'].get('projectExecution') is not True:
                raise ValueError('所选 Runtime 未声明完整 Agent 工程执行能力')
            files = {name: base64.b64decode(value, validate=True) for name, value in skill_set.get('assets', {}).items()}
            for skill in skill_set['skills']:
                files.update({name: base64.b64decode(value, validate=True) for name, value in skill.get('files', {}).items()})
                files[skill['skillFile']] = skill['instructions'].encode('utf-8')
            if len(files) > caps['limits']['maxFiles'] or sum(map(len, files.values())) > caps['limits']['maxArchiveBytes'] or self.options['timeoutMs'] > caps['limits']['maxTimeoutMs']:
                raise ValueError('实例输入超过 Runtime 容量限制')
            environment, secrets = extract_secrets(self.options['environment'], self.options.get('secrets'))
            parameters = self.options['model'].get('parameters', {})
            self.generation = {'schemaVersion': 'finance.eval-generation.v1', **parameters} if parameters else None
            body = {'schemaVersion': 'finance.runtime-instance.v1', 'runId': context['runId'], 'side': self.options['side'],
                'modelId': self.options['model']['modelId'], 'environment': environment, 'configuration': self.options.get('configuration', {}),
                'secrets': secrets, 'limits': {'timeoutMs': self.options['timeoutMs']}, **skill_set,
                **({'generation': self.generation} if self.generation else {})}
            validate('finance.runtime-instance.v1', body)
            key = fingerprint({'leaseId': self.lease_id, 'runId': context['runId'], 'side': self.options['side'],
                'configuration': fingerprint(body), **({'incarnation': self.incarnation} if self.incarnation else {})})
            while True:
                status, value = await self.request('POST', 'v1/runtime-instances', body=body, headers={'idempotency-key': key}, allow_error=True)
                if 200 <= status < 300:
                    self.instance = validate('finance.skill-eval.runtime-instance-state.v1', {'executeEndpoint': None, 'error': None, **value})
                    break
                if status != 409 or value.get('error') != 'RUNTIME_INSTANCE_CAPACITY':
                    raise self.response_error(status, value)
                await asyncio.sleep(1)
            async def poll():
                _, value = await self.request('GET', 'v1/runtime-instances/' + quote(self.instance['instanceId'], safe=''))
                self.instance = validate('finance.skill-eval.runtime-instance-state.v1', {'executeEndpoint': None, 'error': None, **value})
            if self.options.get('requireStatusPoll') and self.instance['status'] != 'starting':
                await poll()
            while self.instance['status'] == 'starting':
                await asyncio.sleep(.25)
                await poll()
            if self.instance['status'] != 'ready' or not self.instance.get('executeEndpoint'):
                raise RuntimeError('Runtime instance failed to start')
            self.execute_url = controlled_url(self.base_url, self.instance['executeEndpoint'])

    async def execute(self, request, on_event=None):
        async with self.execution_lock:
            if self.state_blocked:
                raise ExecutionFailure('业务状态恢复未被证明成功，已停止后续业务执行')
            if request['evalCase'].get('stateFixture') and not self.state_supported:
                raise ExecutionFailure('Runtime 未提供业务初态、采集和恢复能力，未执行业务', {'executionDisposition': 'NOT_EXECUTED'})
            if self.options.get('stopAfterFailure') and self.failed_case_id:
                raise ExecutionFailure('Runtime case not executed', {'executionDisposition': 'NOT_EXECUTED', 'blockedByCaseId': self.failed_case_id})
            try:
                if self.recovery_required:
                    await self.cleanup()
                    self.incarnation += 1
                    await self.prepare({'runId': request['runId']})
                    self.recovery_required = False
                async def execute():
                    return await self.execute_prepared(request, on_event)
                def finished(record):
                    self.state_receipts.append(record)
                    if any(error['phase'] == 'restore' for error in record['errors']):
                        self.state_blocked = True
                result = await with_case_state(request, self.state_action, execute, finished) if request['evalCase'].get('stateFixture') else await execute()
                if result['status'] == 'failed':
                    self.recovery_required, self.failed_case_id = True, request['evalCase']['caseId']
                return result
            except (Exception, asyncio.CancelledError):
                self.recovery_required, self.failed_case_id = True, request['evalCase']['caseId']
                raise

    async def state_action(self, body):
        if not self.instance:
            raise ValueError('State operation requires a live Runtime instance')
        _, value = await self.request('POST', 'v1/runtime-instances/' + quote(self.instance['instanceId'], safe='') + '/case-state', body=body)
        return value

    async def execute_prepared(self, request, on_event):
        if not self.instance or not self.execute_url:
            raise ValueError('Runtime instance is not ready')
        case = request['evalCase']
        async with asyncio.timeout(self.timeout):
            if case.get('turns'):
                _, caps = await self.request('GET', 'v1/runtime-capabilities')
                validate('finance.runtime-capabilities.v1', caps)
                if caps['features'].get('multiTurn') is not True:
                    raise ValueError('所选 Runtime 尚未声明真实多轮续接能力，复用验收未执行')
            body = {'schemaVersion': 'finance.skill-eval.runtime-case.v1', 'caseId': case['caseId'], 'query': case['prompt'],
                    'requiredTools': case.get('requiredTools', []), 'workspaceFiles': case.get('workspaceFiles', []),
                    **({'turns': case['turns']} if case.get('turns') else {})}
            validate('finance.skill-eval.runtime-case.v1', body)
            headers = {**self.options.get('headers', {}), **({'traceparent': request['traceparent']} if request.get('traceparent') else {})}
            async with client(self.timeout, transport=self.transport) as http:
                async with http.stream('POST', self.execute_url, headers=headers, json=body) as response:
                    await require_success(response)
                    payload, observations, truncated = await self.read_execution(response, request, on_event)
        terminal = payload.get('evidence', payload)
        evidence = validate('finance.skill-eval.runtime-evidence.v1', {
            'toolCalls': [], 'loadedSkills': [], 'usage': None, 'metadata': {}, **terminal})
        if evidence['status'] == 'failed' and not evidence['runtimeIdentityVerified']:
            self.verify(evidence, request)
        evidence = with_process(evidence, True)
        self.verify(evidence, request)
        return {**evidence, 'traceFingerprint': evidence.get('traceFingerprint') or fingerprint(evidence),
            'metadata': {**evidence['metadata'], 'executionMode': 'runtime-launcher', 'runtimeEndpoint': self.origin,
                         'instanceId': self.instance['instanceId'], 'observationSummary': observations, 'observationSummaryTruncated': truncated}}

    async def read_execution(self, response, request, on_event):
        if 'text/event-stream' not in response.headers.get('content-type', ''):
            return await bounded_json(response, 262144, 'Runtime Launcher evidence'), [], False
        evidence, observations, truncated = None, [], False
        async def emit(event):
            if on_event:
                result = on_event({**event, 'caseId': request['evalCase']['caseId'], 'side': request['side']})
                if inspect.isawaitable(result):
                    await result
        async for event in sse_events(response):
            if event.get('evidence') is not None:
                if len(json.dumps(event['evidence'], ensure_ascii=False, separators=(',', ':')).encode()) > 262144:
                    raise ValueError('Runtime Launcher evidence exceeds 262144 bytes')
                if evidence is not None and fingerprint(evidence) != fingerprint(event['evidence']):
                    raise ValueError('Runtime stream returned conflicting terminal evidence')
                evidence = event['evidence']
            elif event.get('schemaVersion') == 'finance.runtime-observation.v1':
                validate('finance.runtime-observation.v1', event)
                expected = {'runId': request['runId'], 'caseId': request['evalCase']['caseId'], 'side': request['side']}
                if event['instanceId'] != self.instance['instanceId'] or any(key in event and event[key] != value for key, value in expected.items()):
                    raise ValueError('Runtime observation does not match the requested case')
                summary = observation_summary(event)
                if summary:
                    if len(observations) < 64:
                        observations.append(summary)
                    else:
                        truncated = True
                kind, payload = event['kind'], event['payload']
                if kind == 'output.delta':
                    await emit({'type': 'text_delta', 'text': payload['text']})
                elif kind.startswith('tool.call.'):
                    await emit({'type': 'tool_start' if kind == 'tool.call.started' else 'tool_end', 'toolName': payload.get('name'), 'status': kind})
                elif kind.startswith('execution.'):
                    await emit({'type': 'status', 'status': kind, 'text': payload.get('message')})
                if kind == 'execution.failed':
                    code = (payload.get('error') or {}).get('code', '')
                    metadata = {'instanceId': self.instance['instanceId'], 'launcherTraceId': event['traceId']}
                    if event['source'].get('adapter') == 'finance-solution-builder' and event['source'].get('nativeEventType') == 'builder.execution-correlation.v1':
                        fields = (event.get('native') or {}).get('data') or {}
                        diagnostic = {key: fields[key] for key in ('buildId', 'hostInstanceId', 'hostRunId', 'hostTraceId')
                                      if isinstance(fields.get(key), str) and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:@-]{0,127}', fields[key])}
                        if diagnostic:
                            metadata['launcherDiagnostics'] = {'basis': 'LAUNCHER_CORRELATION_NOT_EXECUTION_VERIFICATION', **diagnostic}
                    raise ExecutionFailure('Runtime execution failed: ' + (code if re.fullmatch(r'[A-Z][A-Z0-9_]{0,119}', code) else 'EXECUTION_FAILED'), metadata)
            elif event.get('type') in ('status', 'text_delta', 'tool_start', 'tool_end'):
                await emit(event)
        if evidence is None:
            raise ValueError('Runtime instance stream ended without execution evidence')
        return evidence, observations, truncated

    def verify(self, evidence, request):
        metadata, case = evidence['metadata'], request['evalCase']
        if any(evidence[key] != expected for key, expected in {'runId': request['runId'], 'side': request['side'], 'caseId': case['caseId']}.items()):
            raise ValueError('Runtime instance evidence does not match the requested case')
        if evidence['modelId'] != self.options['model']['modelId']:
            raise ValueError('Runtime instance used a different model')
        if evidence['status'] == 'failed' and not evidence['runtimeIdentityVerified']:
            raise ExecutionFailure(evidence['error'] or 'Runtime instance stopped before producing verified execution evidence', metadata)
        if self.generation and (metadata.get('declaredModelParameters') != {k: v for k, v in self.generation.items() if k != 'schemaVersion'} or metadata.get('modelGenerationHostVerified') is not True):
            raise ValueError('Runtime instance did not verify the requested generation configuration')
        skill_set = self.options['skillSet']
        members = [{k: s[k] for k in ('id', 'skillId', 'skillFile', 'version', 'artifactSha256')} for s in skill_set['skills']]
        if skill_set.get('executionMode') == 'agent_project':
            if metadata.get('projectExecution') is not True or metadata.get('contentDigest') != skill_set['contentDigest']:
                raise ValueError('原工程内容摘要或原 Agent 工程执行证明与本次基线不一致')
        elif (metadata.get('contentDigest') != skill_set['contentDigest'] or
              sorted(metadata.get('loadedSkillMembers', []), key=lambda m: m['id']) != sorted(members, key=lambda m: m['id']) or
              any(not any(s['skillId'] == m['skillId'] and s['version'] == m['version'] for s in evidence['loadedSkills']) for m in members)):
            raise ValueError('整组 Skill 装载清单或内容摘要与本次候选不一致')
        skill, variant = self.options.get('skill'), self.options['variant']
        if skill and not any(s['skillId'] == skill['skillId'] and s['version'] == skill['version'] for s in evidence['loadedSkills']):
            raise ValueError('Runtime instance did not load the requested Skill artifact')
        if variant['mode'] == 'without_target_skill' and any(s['skillId'] == variant['skillId'] for s in evidence['loadedSkills']):
            raise ValueError('Baseline Runtime instance unexpectedly loaded the target Skill')
        if metadata.get('instanceConfigurationDigest') != self.instance['configurationDigest']:
            raise ValueError('Runtime instance evidence has a different configuration digest')
        files = case.get('workspaceFiles', [])
        if metadata.get('workspaceFilesDigest') != (workspace_digest(files) if files else None):
            raise ValueError('Runtime instance did not mount the requested test data')
        if case.get('turns'):
            receipt = metadata.get('conversation') or {}
            turns = receipt.get('turns', [])
            if not receipt.get('sessionId') or not receipt.get('workspaceId') or (len(turns) != len(case['turns']) if evidence['status'] == 'completed' else len(turns) > len(case['turns'])):
                raise ValueError('Runtime conversation evidence does not match the real requested turns')
            for index, turn in enumerate(turns):
                if turn['index'] != index or turn['queryDigest'] != fingerprint(case['turns'][index]['query']) or turn['status'] != 'completed' or turn['outputDigest'] != fingerprint(turn['output']) or any(name not in turn['toolNames'] for name in case['turns'][index].get('requiredTools', [])):
                    raise ValueError('Runtime conversation evidence does not match the real requested turns')
            if evidence['status'] == 'completed':
                if evidence['output'] != '\n\n'.join(f'Turn {index+1}:\n' + turn['output'] for index, turn in enumerate(turns)):
                    raise ValueError('Runtime conversation output evidence does not match')
                if sorted(name for turn in turns for name in turn['toolNames']) != sorted(c['name'] for c in evidence['toolCalls'] if c['status'] == 'completed'):
                    raise ValueError('Runtime conversation tool receipts do not match execution evidence')

    async def cleanup(self):
        instance = self.instance
        if not instance:
            return
        ident = instance['instanceId']
        self.cleanup_observation = {'status': 'REQUESTED', 'instanceId': ident}
        try:
            for attempt in range(10):
                try:
                    status, payload = await self.request('DELETE', 'v1/runtime-instances/' + quote(ident, safe=''), timeout=10, allow_error=True, limit=65536)
                except Exception:
                    self.cleanup_observation = {'status': 'REQUEST_FAILED', 'instanceId': ident}
                    raise
                try:
                    receipt = validate('finance.eval-cleanup-observation.v1', payload.get('cleanup'))
                    receipt = {key: value for key, value in receipt.items() if key in {
                        'schemaVersion', 'instanceId', 'observedAt', 'status', 'scope', 'buildId', 'hostInstanceId'}}
                    if receipt['instanceId'] != ident:
                        raise ValueError('Mismatched cleanup receipt')
                    self.cleanup_observation = receipt
                except ValueError:
                    self.cleanup_observation = {'status': 'UNKNOWN', 'instanceId': ident, 'httpStatus': status, 'reason': 'NO_RESOURCE_RECEIPT'}
                if not 200 <= status < 300 and status != 404:
                    raise self.response_error(status, payload)
                if self.cleanup_observation['status'] == 'PENDING' and attempt < 9:
                    await asyncio.sleep(.2)
                    continue
                break
            if self.cleanup_observation['status'] != 'RELEASED':
                raise RuntimeError('Runtime 未提供资源释放成功的回执')
            self.instance = self.execute_url = None
        finally:
            self.cleanup_receipts[ident] = deepcopy(self.cleanup_observation)

    def finalization_evidence(self):
        instances = list(self.cleanup_receipts.values())
        result = deepcopy(self.cleanup_observation) if len(instances) <= 1 else {
            'status': 'RELEASED' if all(item['status'] == 'RELEASED' for item in instances) else 'UNKNOWN',
            'scope': 'ALL_CREATED_INSTANCES', 'instances': deepcopy(instances)}
        if self.state_receipts:
            result['caseState'] = deepcopy(self.state_receipts)
        return result

    @staticmethod
    def response_error(status, payload):
        code = payload.get('error') if isinstance(payload, dict) else None
        if not isinstance(code, str) or not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,79}', code):
            code = None
        return RemoteError(f'Runtime Launcher HTTP {status}' + (f': {code}' if code else ''), code=code, status=status)
