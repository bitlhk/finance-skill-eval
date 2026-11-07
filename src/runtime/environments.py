"""Workspace environment registry and live admission checks.

The shared filesystem lock covers registry read/modify/write across API workers.
Remote inspection runs outside that lock and never changes admission metadata.
"""
import asyncio
from copy import deepcopy
import os
from pathlib import Path
import re
from time import monotonic
from urllib.parse import urlsplit
from uuid import uuid4

from filelock import FileLock

from api.contracts import validate
from storage.coordination import lock_path
from storage.tasks import read_json, write_json
from tasks.values import now
from .contracts import validate as runtime_contract
from .launcher import base_url
from .mcp import inspect as inspect_mcp
from .transport import client, bounded_json, require_success, controlled_url


class EnvironmentError(ValueError):
    def __init__(self, message, status=400, code=None):
        super().__init__(message)
        self.status, self.code = status, code


def available(record):
    if record.get('archived'):
        raise EnvironmentError('Environment is archived', 409, 'ENVIRONMENT_ARCHIVED')
    return record


def headers_for(record):
    available(record)
    name = record.get('credentialEnv')
    if not name:
        return {}
    value = os.environ.get(name)
    if not value:
        raise EnvironmentError('Credential environment variable is unavailable: ' + name)
    return {'authorization': value if value.startswith('Bearer ') else 'Bearer ' + value}


def normalize_input(value):
    value = deepcopy(value)
    if not isinstance(value, dict):
        raise EnvironmentError('Invalid environment')
    if isinstance(value.get('name'), str):
        value['name'] = value['name'].strip()
    kind = value.get('type')
    if kind == 'runtime_launcher':
        value['baseUrl'] = base_url(value.get('baseUrl', ''))
    elif kind == 'mcp_streamable_http':
        parsed = urlsplit(value.get('endpoint', ''))
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise EnvironmentError('Use an HTTP(S) endpoint without embedded credentials or fragments')
        value.setdefault('mcpEnvironmentIds', [])
    elif kind == 'execution_environment':
        value.setdefault('mcpEnvironmentIds', [])
    validate('environment_create', value)
    ids = value.get('mcpEnvironmentIds', [])
    if len(ids) != len(set(ids)):
        raise EnvironmentError('Duplicate MCP bindings')
    return value


def normalize_record(value):
    value = deepcopy(value)
    value.setdefault('archived', False)
    if value['type'] == 'execution_environment':
        value.setdefault('defaultModelId', None)
        value.setdefault('mcpEnvironmentIds', [])
    else:
        value.setdefault('credentialEnv', None)
    if value['type'] != 'runtime_launcher':
        value['runtimeType'] = None
    validate('environment_record', value)
    return value


class EnvironmentStore:
    def __init__(self, root, launcher_trust=None, *, transport=None):
        self.root = Path(root)
        self.directory = self.root / 'environments'
        self.trust = launcher_trust or []
        self.transport = transport

    def _get(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch(r'[a-z0-9-]+', identifier):
            return None
        path = self.directory / (identifier + '.json')
        if path.is_symlink():
            raise EnvironmentError('Environment record cannot be a symlink')
        try:
            return normalize_record(read_json(path))
        except (FileNotFoundError, ValueError, KeyError, TypeError):
            return None

    def _list(self, include_archived=False):
        records = [self._get(path.stem) for path in self.directory.glob('*.json')]
        return sorted((item for item in records if item and (include_archived or not item['archived'])),
                      key=lambda item: item['updatedAt'], reverse=True)

    async def get(self, identifier):
        return await asyncio.to_thread(self._get, identifier)

    async def list(self, include_archived=False):
        return await asyncio.to_thread(self._list, include_archived)

    def _require(self, identifier):
        record = self._get(identifier)
        if not record:
            raise EnvironmentError('Environment not found', 404)
        return available(record)

    def _validate_bindings(self, record):
        if record['type'] != 'execution_environment':
            return
        if self._require(record['launcherEnvironmentId'])['type'] != 'runtime_launcher':
            raise EnvironmentError('Runtime Launcher is unavailable')
        for identifier in record['mcpEnvironmentIds']:
            if self._require(identifier)['type'] != 'mcp_streamable_http':
                raise EnvironmentError('MCP binding is unavailable: ' + identifier)

    async def require_available(self, identifier):
        def resolve():
            record = self._require(identifier)
            self._validate_bindings(record)
            return record
        return await asyncio.to_thread(resolve)

    async def resolve_launcher(self, record):
        record = await self.require_available(record['environmentId'])
        if record['type'] == 'runtime_launcher':
            return {'launcher': record, 'mcpEnvironmentIds': [], 'defaultModelId': None}
        if record['type'] != 'execution_environment':
            raise EnvironmentError('Execution environment is unavailable')
        return {'launcher': await self.require_available(record['launcherEnvironmentId']),
                'mcpEnvironmentIds': record['mcpEnvironmentIds'], 'defaultModelId': record['defaultModelId']}

    async def mutate(self, action, identifier=None, value=None):
        def work():
            with FileLock(str(lock_path(self.root, 'environment-registry'))):
                previous = self._get(identifier) if identifier else None
                if action != 'create' and previous is None:
                    raise EnvironmentError('Environment not found', 404)
                if action == 'remove':
                    for other in self._list(True):
                        if identifier in other.get('mcpEnvironmentIds', []) or identifier == other.get('launcherEnvironmentId'):
                            raise EnvironmentError('Environment is still bound by ' + other['name'], 409)
                    (self.directory / (identifier + '.json')).unlink()
                    return None
                if action == 'archive':
                    if not isinstance(value, dict) or set(value) != {'archived'} or not isinstance(value['archived'], bool):
                        raise EnvironmentError('Invalid archive request')
                    if previous['archived'] == value['archived']:
                        return previous
                    record = {**previous, **value, 'updatedAt': now()}
                else:
                    parsed = normalize_input(value)
                    self._validate_bindings(parsed)
                    if previous and previous['type'] != parsed['type']:
                        raise EnvironmentError('Resource type cannot change; create a new environment instead', 409)
                    if previous and previous.get('delivery'):
                        if any(parsed.get(key, previous.get(key)) != previous.get(key) for key in ('baseUrl', 'runtimeType', 'credentialEnv')):
                            raise EnvironmentError('Builder 管理的 Runtime Launcher 连接配置不可修改；请提交新的 Builder 交付并重新验收。', 409)
                        record = {**previous, 'name': parsed['name'], 'updatedAt': now()}
                    else:
                        record = {**(previous or {}), **parsed, 'updatedAt': now()}
                        record.setdefault('environmentId', 'env-' + str(uuid4())[:12])
                        record.setdefault('createdAt', record['updatedAt'])
                record = normalize_record(record)
                self.directory.mkdir(parents=True, exist_ok=True)
                write_json(self.directory / (record['environmentId'] + '.json'), record)
                return record
        return await asyncio.to_thread(work)

    async def fetch_json(self, record, suffix, *, limit=1048576):
        async with client(60, transport=self.transport) as http:
            async with http.stream('GET', controlled_url(record['baseUrl'], suffix), headers=headers_for(record)) as response:
                await require_success(response)
                return await bounded_json(response, limit)

    async def native_tool_catalog(self, identifier):
        record = await self.require_available(identifier)
        if record['type'] != 'runtime_launcher':
            raise EnvironmentError('请选择已登记的原生 Runtime Launcher', 409)
        catalog = await self.fetch_json(record, 'v1/native-tool-catalog')
        validate('native_tool_catalog', catalog)
        if catalog['runtime']['type'] != record['runtimeType']:
            raise EnvironmentError('工具目录与登记的 Runtime 不一致', 409)
        return {'environmentId': identifier, 'catalog': catalog}

    async def preflight(self, record):
        record = await self.require_available(record['environmentId'])
        if record['type'] == 'execution_environment':
            resolved = await self.resolve_launcher(record)
            result = await self.preflight(resolved['launcher'])
            if result['status'] != 'ready':
                return result
            capabilities = result['capabilities']
            if resolved['defaultModelId'] and not any(model['modelId'] == resolved['defaultModelId'] for model in capabilities['models']):
                return {**result, 'status': 'failed', 'error': '执行环境默认模型不属于所选 Runtime Launcher'}
            if resolved['mcpEnvironmentIds'] and not capabilities['features'].get('externalMcp'):
                return {**result, 'status': 'failed', 'error': '所选 Runtime Launcher 不支持动态外部 MCP'}
            return result
        if record['type'] == 'mcp_streamable_http':
            return await inspect_mcp(record['endpoint'], headers_for(record))
        started = monotonic()
        try:
            capabilities = await self.fetch_json(record, 'v1/runtime-capabilities')
            runtime_contract('finance.runtime-capabilities.v1', capabilities)
            if record['runtimeType'] != 'generic_http' and capabilities['runtime']['type'] != record['runtimeType']:
                raise EnvironmentError('Runtime type does not match the registered Launcher')
            return {'status': 'ready', 'elapsedMs': round((monotonic() - started) * 1000), 'error': None, 'capabilities': capabilities}
        except Exception as error:
            return {'status': 'failed', 'elapsedMs': round((monotonic() - started) * 1000), 'error': str(error)}

    async def inspect(self, record):
        started = monotonic()
        primary = await self.preflight(record)
        capabilities = primary.get('capabilities')
        names = list(dict.fromkeys((capabilities or {}).get('nativeToolNames', [])))
        servers = []
        mcp_records = [record] if record['type'] == 'mcp_streamable_http' else [await self.get(item) or {
            'environmentId': item, 'name': item, 'type': 'missing'} for item in record.get('mcpEnvironmentIds', [])]
        for mcp in mcp_records:
            result = primary if mcp is record else await self.preflight(mcp) if mcp['type'] == 'mcp_streamable_http' else {
                'status': 'failed', 'error': 'MCP 环境不存在', 'tools': []}
            tools = [item['name'] for item in result.get('tools', [])] if result['status'] == 'ready' else []
            names.extend(tools)
            servers.append({'environmentId': mcp['environmentId'], 'name': mcp['name'], 'status': result['status'],
                            'toolNames': tools, 'error': result.get('error')})
        failure = next((item for item in servers if item['status'] == 'failed'), None)
        names = list(dict.fromkeys(names))
        return {'status': 'ready' if primary['status'] == 'ready' and not failure else 'failed',
                'elapsedMs': round((monotonic() - started) * 1000), 'error': primary.get('error') or (failure or {}).get('error'),
                'toolCount': len(names), 'tools': [{'name': name} for name in names], 'mcpServers': servers,
                **({'capabilities': capabilities} if capabilities else {})}

    async def accept_builder_delivery(self, value):
        from datetime import datetime, timezone
        import base64
        import hashlib
        from assets.runtime_skills import from_files
        from .build_admission import delivery_issues
        from .launcher import RuntimeLauncher
        requirements, result = value['requirements'], value['result']
        validate('build_requirements', requirements)
        validate('build_result', result)
        launcher = result.get('launcher')
        if not launcher:
            raise EnvironmentError('Builder 没有返回可用的 Runtime Launcher。')
        registered = next((item for item in await self.list(True) if item.get('delivery', {}).get('deploymentId') == launcher['deploymentId']), None)
        if registered:
            available(registered)
        if launcher.get('expiresAt') and datetime.fromisoformat(launcher['expiresAt'].replace('Z', '+00:00')) <= datetime.now(timezone.utc):
            raise EnvironmentError('Builder 返回的 Runtime Launcher 已过期。')
        trust = next((item for item in self.trust if item['reference'] == value['trustReference']), None)
        if not trust:
            raise EnvironmentError('Launcher 信任引用不存在或未由服务端配置。')
        prefix = base_url(trust['baseUrlPrefix'])
        delivered = base_url(launcher['baseUrl'])
        controlled_url(prefix, delivered)
        credential = trust.get('credentialEnv')
        if launcher['authentication']['type'] == 'bearer' and not credential:
            raise EnvironmentError('该 Launcher 要求 Bearer 凭据，但信任引用没有配置专用凭据。')
        if launcher['authentication']['type'] != 'bearer' and credential:
            raise EnvironmentError('该 Launcher 声明无需认证，但信任引用绑定了凭据。')
        temporary = {'baseUrl': delivered, 'credentialEnv': credential}
        capabilities = await self.fetch_json(temporary, 'v1/runtime-capabilities')
        runtime_contract('finance.runtime-capabilities.v1', capabilities)
        issues = delivery_issues(requirements, result, capabilities)
        if issues:
            raise EnvironmentError('Builder 交付未通过验收: ' + ', '.join(issues))
        file_probe = 'read_file' in capabilities.get('nativeToolNames', [])
        method_probe = not file_probe and capabilities['features'].get('managedMethodProbe') is True
        if not file_probe and not method_probe:
            raise EnvironmentError('Runtime has no declared supported Skill-loading probe')
        mounted = ['read_file'] if file_probe else capabilities.get('managedMethodProbeToolNames', [])
        minimum = capabilities['limits'].get('minPrimaryTools')
        if method_probe and (minimum is None or len(mounted) < minimum or len(mounted) != len(set(mounted)) or any(
                tool not in capabilities.get('nativeToolNames', []) or tool in capabilities.get('auxiliaryToolNames', []) for tool in mounted)):
            raise EnvironmentError('Managed probe tool declaration is missing or invalid')
        probe_id, nonce = 'conformance-' + str(uuid4()), 'RUNTIME_PROBE_' + str(uuid4())
        import json
        instructions = ('---\nname: runtime-conformance\ndescription: Verify isolated Runtime loading and tool execution.\n---\n'
                        'Read conformance/probe.txt using read_file and return the exact file contents.') if file_probe else (
                        '---\nname: runtime-conformance\nallowed-tools: ' + json.dumps(mounted) + '\n---\n'
                        'Return exactly this platform verification marker: ' + nonce + '\nDo not call business tools or produce a business report.')
        digest = hashlib.sha256(('SKILL.md\0' + instructions + '\0').encode()).hexdigest()
        skill_set = from_files({'digest': digest, 'files': {'SKILL.md': base64.b64encode(instructions.encode()).decode()},
            'members': [{'id': 'runtime-conformance', 'skillId': 'runtime-conformance', 'version': '1', 'skillFile': 'SKILL.md', 'artifactSha256': digest}]})
        variant = {'mode': 'skill_version', 'skillId': 'bundle', 'version': 'frozen', 'artifactSha256': digest}
        model = {'providerId': 'launcher-conformance', 'modelId': capabilities['defaultModelId'], 'parameters': {}}
        owner = RuntimeLauncher({'baseUrl': delivered, 'headers': headers_for(temporary), 'side': 'right', 'model': model,
            'variant': variant, 'skill': None, 'skillSet': skill_set, 'environment': {'environmentId': 'runtime-conformance', 'requiredToolNames': mounted},
            'configuration': {}, 'secrets': {'mode': 'inline', 'values': {}}, 'timeoutMs': min(capabilities['limits']['maxTimeoutMs'], 300000),
            'requireStatusPoll': True}, transport=self.transport)
        failure = None
        try:
            await owner.prepare({'runId': probe_id})
            evidence = await owner.execute({'runId': probe_id, 'side': 'right', 'model': model, 'variant': variant, 'evalCase': {
                'caseId': 'launcher-lifecycle', 'name': 'Launcher lifecycle conformance', 'taskMode': 'single_turn',
                'prompt': 'Read conformance/probe.txt with read_file and return its exact content.' if file_probe else 'Return the exact platform verification marker from the installed method. Do not call tools.',
                'evaluationGoal': 'Verify the complete Launcher lifecycle.', 'requiredTools': ['read_file'] if file_probe else [],
                'workspaceFiles': [{'path': 'conformance/probe.txt', 'content': nonce}] if file_probe else [], 'rubric': []}})
            if evidence['status'] != 'completed' or not evidence.get('runtimeIdentityVerified') or not evidence.get('streamCompleted') or nonce not in evidence['output']:
                raise EnvironmentError('Launcher conformance execution did not return the mounted probe data')
            if file_probe and not any(item['name'] == 'read_file' and item['status'] == 'completed' for item in evidence.get('toolCalls', [])):
                raise EnvironmentError('Lifecycle probe did not execute the file tool')
            if method_probe and (evidence['output'].strip() != nonce or evidence.get('toolCalls') or evidence.get('metadata', {}).get('skillSetInstallation') != 'COMPILED_INTO_MANAGED_METHOD'):
                raise EnvironmentError('Managed method probe did not verify exact instructions without business calls')
        except Exception as error:
            failure = error
        finally:
            try:
                await owner.cleanup()
            except Exception as error:
                failure = EnvironmentError('实例清理失败: ' + str(error))
        if failure:
            raise EnvironmentError('Launcher 生命周期验收失败: ' + str(failure))
        def register():
            with FileLock(str(lock_path(self.root, 'environment-registry'))):
                existing = next((item for item in self._list(True) if item.get('delivery', {}).get('deploymentId') == launcher['deploymentId']), None)
                timestamp = now()
                if existing:
                    available(existing)
                    if existing['delivery']['resultDigest'] != result['resultDigest'] or existing['baseUrl'] != delivered:
                        raise EnvironmentError('相同 deploymentId 已登记，但交付摘要或地址不同。', 409)
                    if existing['delivery'].get('requirementsDigest') != requirements['requirementsDigest']:
                        existing['delivery']['requirementsDigest'] = requirements['requirementsDigest']
                        existing['updatedAt'] = timestamp
                        write_json(self.directory / (existing['environmentId'] + '.json'), existing)
                    return {'environment': existing, 'capabilities': capabilities, 'created': False}
                kind = launcher['runtime']['type']
                record = normalize_record({'environmentId': 'env-' + str(uuid4())[:12],
                    'name': (value.get('name') or '').strip() or result['builder']['name'] + ' · ' + kind,
                    'type': 'runtime_launcher', 'runtimeType': kind if kind in ('openjiuwen', 'agentscope', 'ea') else 'generic_http',
                    'baseUrl': delivered, 'credentialEnv': credential, 'createdAt': timestamp, 'updatedAt': timestamp,
                    'delivery': {'schemaVersion': 'finance.runtime-launcher-delivery-record.v1',
                        **{key: result[key] for key in ('buildId', 'requestId', 'requirementsDigest', 'resultDigest', 'builder')},
                        **{key: launcher[key] for key in ('deploymentId', 'artifactSha256', 'capabilitiesDigest', 'expiresAt')},
                        'acceptedAt': timestamp, 'evalConformance': {'status': 'PASSED', 'testedAt': timestamp,
                            'checks': ['capabilities', 'create', 'status', 'execute', 'evidence', 'delete'],
                            'probeKind': 'MANAGED_METHOD_INSTRUCTION_NONCE' if method_probe else 'WORKSPACE_FILE_READ',
                            'runId': probe_id, 'instanceSchemaVersion': 'finance.runtime-instance.v1', 'probeDigest': digest}}})
                self.directory.mkdir(parents=True, exist_ok=True)
                write_json(self.directory / (record['environmentId'] + '.json'), record)
                return {'environment': record, 'capabilities': capabilities, 'created': True}
        return await asyncio.to_thread(register)

    async def rollback_builder_delivery(self, identifier, result_digest):
        def rollback():
            with FileLock(str(lock_path(self.root, 'environment-registry'))):
                record = self._get(identifier)
                if record and record.get('delivery', {}).get('resultDigest') == result_digest:
                    (self.directory / (identifier + '.json')).unlink()
        await asyncio.to_thread(rollback)
