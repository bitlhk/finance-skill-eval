"""In-memory Runtime instance leases. Secrets are hydrated only into the execution copy."""
import copy
import base64
import hashlib
import io
import json
from pathlib import PurePosixPath
import time
import uuid
import zipfile


class InstanceManager:
    def __init__(self, ttl_seconds=900, max_archive_bytes=8 * 1024 * 1024, max_files=200,
                 max_uncompressed_bytes=16 * 1024 * 1024):
        self.ttl_seconds = ttl_seconds
        self.max_archive_bytes = max_archive_bytes
        self.max_files = max_files
        self.max_uncompressed_bytes = max_uncompressed_bytes
        self.instances = {}
        self.idempotency = {}

    def _hydrate_archive(self, request):
        skill = request.get('skill')
        if not skill or not skill.get('archiveBase64'):
            return
        try:
            archive = base64.b64decode(skill.pop('archiveBase64'), validate=True)
        except (ValueError, TypeError):
            raise ValueError('Skill archive is not valid base64') from None
        if len(archive) > self.max_archive_bytes:
            raise ValueError('Skill archive exceeds the Runtime limit')
        archive_digest = skill.get('archiveSha256')
        if not isinstance(archive_digest, str) or len(archive_digest) != 64:
            raise ValueError('Skill archive digest is missing or invalid')
        if hashlib.sha256(archive).hexdigest() != archive_digest:
            raise ValueError('Skill archive digest does not match the transferred archive')
        try:
            with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
                members = [member for member in bundle.infolist() if not member.is_dir()]
                if len(members) > self.max_files:
                    raise ValueError('Skill archive contains too many files')
                if sum(member.file_size for member in members) > self.max_uncompressed_bytes:
                    raise ValueError('Uncompressed Skill archive exceeds the Runtime limit')
                files = skill.setdefault('files', {})
                seen = set()
                for member in members:
                    path = PurePosixPath(member.filename.replace('\\', '/'))
                    if path.is_absolute() or '..' in path.parts:
                        raise ValueError('Skill archive contains an unsafe path')
                    normalized = path.as_posix()
                    if normalized in seen:
                        raise ValueError('Skill archive contains duplicate paths')
                    seen.add(normalized)
                    content = bundle.read(member)
                    try:
                        files[normalized] = content.decode('utf-8')
                    except UnicodeDecodeError:
                        # The current worker materializes text assets. Binary assets remain
                        # represented by the verified archive but are not passed to the agent.
                        continue
        except zipfile.BadZipFile:
            raise ValueError('Skill archive is not a valid zip file') from None

    def _digest(self, request):
        public = copy.deepcopy(request)
        public['secrets'] = {'mode': request.get('secrets', {}).get('mode', 'inline'),
                             'keys': sorted(request.get('secrets', {}).get('values', {}))}
        return hashlib.sha256(json.dumps(public, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()

    def create(self, request, idempotency_key):
        self.expire()
        if request.get('schemaVersion') != 'finance.skill-eval.runtime-instance.v1':
            raise ValueError('Unsupported Runtime instance contract')
        if not isinstance(request.get('runId'), str) or not request['runId'] or request.get('side') not in ('left', 'right'):
            raise ValueError('Invalid Runtime run identity')
        if not isinstance(request.get('modelId'), str) or not request['modelId']:
            raise ValueError('Invalid Runtime model')
        if not isinstance(request.get('environment'), dict):
            raise ValueError('Invalid Runtime environment')
        timeout = (request.get('limits') or {}).get('timeoutMs')
        if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 10000 or timeout > 900000:
            raise ValueError('Invalid Runtime timeout')
        variant, skill = request.get('variant') or {}, request.get('skill')
        if variant.get('mode') == 'skill_version' and (not isinstance(skill, dict)
                or skill.get('skillId') != variant.get('skillId') or skill.get('version') != variant.get('version')
                or skill.get('artifactSha256') != variant.get('artifactSha256')):
            raise ValueError('Requested Skill identity does not match the artifact')
        secrets = request.get('secrets', {})
        if secrets.get('mode') != 'inline' or not isinstance(secrets.get('values', {}), dict):
            raise ValueError('Only inline Runtime secrets are supported')
        if any(not isinstance(key, str) or not isinstance(value, str) for key, value in secrets.get('values', {}).items()):
            raise ValueError('Runtime secrets must be string values')
        request = copy.deepcopy(request)
        self._hydrate_archive(request)
        digest = self._digest(request)
        request_digest = hashlib.sha256(json.dumps(request, sort_keys=True, separators=(',', ':'), ensure_ascii=True).encode()).hexdigest()
        previous = self.idempotency.get(idempotency_key)
        if previous:
            item = self.instances.get(previous)
            if not item or item['_requestDigest'] != request_digest:
                raise RuntimeError('Idempotency key was reused with different configuration')
            return item
        if len(self.instances) >= 2:
            raise RuntimeError('Runtime instance capacity exceeded')
        instance_id = 'runtime-instance-' + uuid.uuid4().hex[:16]
        now = time.time()
        item = {'schemaVersion': 'finance.skill-eval.runtime-instance-state.v1', 'instanceId': instance_id,
                'status': 'ready', 'executeEndpoint': f'/v1/runtime-instances/{instance_id}/execute',
                'expiresAt': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now + self.ttl_seconds)),
                'error': None, 'configurationDigest': digest, '_request': copy.deepcopy(request),
                '_requestDigest': request_digest, '_expires': now + self.ttl_seconds}
        self.instances[instance_id] = item
        self.idempotency[idempotency_key] = instance_id
        return item

    @staticmethod
    def public(item):
        return {key: value for key, value in item.items() if not key.startswith('_')}

    def get(self, instance_id):
        self.expire()
        return self.instances.get(instance_id)

    def delete(self, instance_id):
        item = self.instances.pop(instance_id, None)
        if item:
            for key, value in list(self.idempotency.items()):
                if value == instance_id: self.idempotency.pop(key, None)
        return item is not None

    def expire(self):
        now = time.time()
        for instance_id, item in list(self.instances.items()):
            if item['_expires'] <= now: self.delete(instance_id)

    def execution(self, instance_id, case):
        item = self.get(instance_id)
        if not item or item['status'] != 'ready': raise KeyError(instance_id)
        if case.get('schemaVersion') != 'finance.skill-eval.runtime-case.v1': raise ValueError('Unsupported Runtime case contract')
        if not isinstance(case.get('caseId'), str) or not case['caseId'] or not isinstance(case.get('query'), str) or not case['query']:
            raise ValueError('Invalid Runtime case')
        required = case.get('requiredTools', [])
        if not isinstance(required, list) or any(not isinstance(name, str) or not name for name in required):
            raise ValueError('Invalid required Runtime tools')
        workspace_files = case.get('workspaceFiles', [])
        if not isinstance(workspace_files, list) or len(workspace_files) > 32:
            raise ValueError('Invalid Runtime workspace files')
        paths, total_bytes = set(), 0
        for workspace_file in workspace_files:
            if not isinstance(workspace_file, dict) or set(workspace_file) != {'path', 'content'}:
                raise ValueError('Invalid Runtime workspace file')
            path, content = workspace_file.get('path'), workspace_file.get('content')
            if (not isinstance(path, str) or not path or len(path) > 240 or '\\' in path or '\0' in path
                    or (len(path) > 1 and path[1] == ':' and path[0].isalpha())
                    or PurePosixPath(path).is_absolute() or any(part in ('', '.', '..') for part in path.split('/'))
                    or not isinstance(content, str)):
                raise ValueError('Invalid Runtime workspace file')
            if path in paths:
                raise ValueError('Duplicate Runtime workspace file path')
            paths.add(path)
            size = len(content.encode('utf-8'))
            if size > 256 * 1024:
                raise ValueError('Runtime workspace file is too large')
            total_bytes += size
        if total_bytes > 1024 * 1024:
            raise ValueError('Runtime workspace files are too large')
        request = copy.deepcopy(item['_request'])
        values = request.pop('secrets', {}).get('values', {})
        environment = request.get('environment') or {}
        for service in environment.get('mcpServers', []):
            if not isinstance(service, dict) or not isinstance(service.get('endpoint'), str) or not service['endpoint'].startswith(('http://', 'https://')):
                raise ValueError('Invalid external MCP service')
            headers = service.setdefault('headers', {})
            for name, ref in service.pop('secretBindings', {}).items():
                if ref not in values: raise ValueError('Missing external MCP secret binding')
                headers[name] = values[ref]
        for service in environment.get('candidateMcpServices', []):
            target = service.setdefault('environment', {})
            for name, ref in service.pop('secretBindings', {}).items():
                if ref not in values: raise ValueError('Missing MCP secret binding')
                target[name] = values[ref]
        for field in (environment.get('runtimeToolConfig') or {}).get('context', {}).values():
            marker = field.get('value')
            if isinstance(marker, dict) and set(marker) == {'$secret'}:
                raw = values.get(marker['$secret'])
                if raw is None: raise ValueError('Missing Runtime context secret')
                field['value'] = raw if field.get('type') == 'string' else json.loads(raw)
        environment['_inlineSecretValues'] = list(values.values())
        request['schemaVersion'] = 'finance.skill-eval.runtime-request.v1'
        request['case'] = {'caseId': case.get('caseId'), 'prompt': case.get('query'), 'taskMode': 'single_turn',
                           'requiredTools': required, 'workspaceFiles': copy.deepcopy(workspace_files)}
        request['model'] = {'providerId': 'runtime-launcher', 'modelId': request.pop('modelId'), 'parameters': {}}
        environment['instanceConfigurationDigest'] = item['configurationDigest']
        return request
