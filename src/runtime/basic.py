"""Native fixed-flow runtimes for frozen evidence, text Skills and business services."""
from copy import deepcopy
import json
import os
from pathlib import Path
from time import monotonic
from urllib.parse import urlsplit

from evaluation.checks import read_pointer
from runtime.transport import client, require_success
from storage.tasks import read_json
from tasks.values import fingerprint


class NoResourcesRuntime:
    state_supported = False
    async def prepare(self, _context):
        pass
    async def cleanup(self):
        pass
    def finalization_evidence(self):
        return {'status': 'NOT_REQUESTED'}


class DirectModelRuntime(NoResourcesRuntime):
    adapter_id = 'direct-model-skill-runtime-v1'
    def __init__(self, adapter, skill):
        self.adapter, self.skill = adapter, skill

    async def execute(self, request, on_event=None):
        if request['evalCase'].get('requiredTools'):
            raise ValueError('Direct model runtime cannot execute required tools')
        started, skill = monotonic(), self.skill
        if request['variant']['mode'] == 'skill_version' and skill is None:
            raise ValueError('Skill artifact is unavailable')
        response = await self.adapter.complete({'requestId': '-'.join((request['runId'], request['side'], request['evalCase']['caseId'])),
            'model': request['model'], 'toolFree': True, 'messages': [{'role': 'system', 'content': '\n\n'.join([
                '你正在完成一项金融岗位任务。只使用题面已提供的事实，不补造当前数据。', '输出应体现专业判断、业务完整性、清晰度和可执行性。',
                '以下是本轮已装配并必须遵循的 Skill：\n<skill>\n' + skill['instructions'] + '\n</skill>' if skill else '本轮不装配目标 Skill，按模型自身能力完成任务。'])},
                {'role': 'user', 'content': request['evalCase']['prompt']}]})
        loaded = [{'skillId': skill['skillId'], 'version': skill['version']}] if skill else []
        body = {'caseId': request['evalCase']['caseId'], 'side': request['side'], 'modelId': response['modelId'],
            'output': response['content'], 'loadedSkills': loaded, 'usage': response.get('usage')}
        return {'runId': request['runId'], **body, 'status': 'completed', 'skillVersion': skill['version'] if skill else None,
            'elapsedMs': round((monotonic() - started) * 1000), 'toolCalls': [], 'runtimeIdentityVerified': request['variant']['mode'] == 'without_target_skill' or bool(skill),
            'streamCompleted': True, 'error': None, 'traceFingerprint': fingerprint(body),
            'metadata': {'executionMode': 'direct-model', 'skillArtifactSha256': skill['artifactSha256'] if skill else None, 'toolExecutionSupported': False}}


class ReplayRuntime(NoResourcesRuntime):
    adapter_id = 'frozen-evidence-replay-v1'
    def __init__(self, pack):
        self.base = Path(pack['sourceFile']).resolve().parent
        self.cache = {}

    async def execute(self, request, on_event=None):
        import asyncio
        replay = request['evalCase'].get('replay')
        if not replay:
            raise ValueError('Case has no replay evidence')
        path = (self.base / replay['evidenceFile']).resolve()
        if not path.is_relative_to(self.base):
            raise ValueError('Replay evidence path escapes Eval Pack')
        if path not in self.cache:
            self.cache[path] = await asyncio.to_thread(read_json, path)
        report = self.cache[path]
        case = next((case for case in report['cases'] if case['promptId'] == replay['sourcePromptId']), None)
        if case is None:
            raise ValueError('Source prompt not found')
        source = case[request['side']]
        usage = source.get('usage')
        return {'runId': request['runId'], 'side': request['side'], 'caseId': request['evalCase']['caseId'],
            'status': source['status'], 'modelId': source['modelId'], 'skillVersion': source.get('skillVersion'), 'output': source['assistantText'],
            'elapsedMs': source['elapsedMs'], 'toolCalls': deepcopy(source.get('toolCalls', [])), 'loadedSkills': deepcopy(source.get('loadedSkills', [])),
            'usage': {target: usage[name] for name, target in [('input', 'inputTokens'), ('output', 'outputTokens'), ('total', 'totalTokens')]
                if type(usage.get(name)) in (int, float)} if usage else None, 'runtimeIdentityVerified': source.get('runtimeIdentityVerified', False),
            'streamCompleted': source.get('streamCompleted', False), 'error': source.get('error'), 'traceFingerprint': fingerprint(source),
            'metadata': {'sourceType': report.get('sourceType', 'ea_runtime'), **({'sourceLabel': report['sourceLabel']} if 'sourceLabel' in report else {}),
                'evidenceFile': str(path.relative_to(self.base))}}


class OriginalServiceRuntime(NoResourcesRuntime):
    adapter_id = 'original-service'
    def __init__(self, configuration, source_digest):
        self.configuration, self.source_digest = configuration, source_digest

    async def execute(self, request, on_event=None):
        config, started = self.configuration, monotonic()
        parsed = urlsplit(config['endpoint'])
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password or parsed.fragment:
            raise ValueError('请输入不含账号、密码或片段的 HTTP 服务地址')
        headers, secrets = {'content-type': 'application/json'}, []
        def redact(value):
            for secret in secrets:
                value = value.replace(secret, '[redacted]')
            return value
        def mapped(value):
            if isinstance(value, str):
                return value.replace('{{input}}', request['evalCase']['prompt']).replace('{{caseId}}', request['evalCase']['caseId'])
            if isinstance(value, list):
                return [mapped(item) for item in value]
            if isinstance(value, dict):
                return {key: mapped(item) for key, item in value.items()}
            return value
        status, output, error = 'failed', '', None
        try:
            for header in config['headers']:
                value = os.getenv(header['env'])
                if not value:
                    raise ValueError('原服务请求头缺少环境变量：' + header['env'])
                if '\r' in value or '\n' in value or '\r' in header['prefix'] or '\n' in header['prefix']:
                    raise ValueError('原服务请求头环境变量包含无效字符')
                secrets.extend((value, header['prefix'] + value))
                headers[header['name']] = header['prefix'] + value
            async with client(config['timeoutMs'] / 1000) as http:
                async with http.stream('POST', config['endpoint'], headers=headers, json=mapped(config['requestTemplate'])) as response:
                    await require_success(response, '原服务')
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > 2097152:
                            raise ValueError('原服务响应超过 2 MB')
            selected = body.decode('utf-8')
            if config['responseFormat'] == 'json':
                payload = json.loads(selected)
                missing = object()
                selected = read_pointer(payload, config['responsePointer'], missing)
                if selected is missing:
                    raise ValueError('原服务响应中不存在配置的返回字段，请检查响应映射')
            output = redact(selected if isinstance(selected, str) else json.dumps(selected, ensure_ascii=False, separators=(',', ':')))
            if not output.strip():
                raise ValueError('原服务映射后的回答为空')
            status = 'completed'
        except Exception as failure:
            error = redact(str(failure))
        return {'runId': request['runId'], 'caseId': request['evalCase']['caseId'], 'side': request['side'], 'status': status, 'output': output, 'error': error,
            'modelId': 'original-service', 'skillVersion': None, 'elapsedMs': round((monotonic() - started) * 1000), 'toolCalls': [], 'loadedSkills': [], 'usage': None,
            'runtimeIdentityVerified': False, 'streamCompleted': status == 'completed', 'metadata': {'baselineService': {
                'configurationFingerprint': fingerprint(config), 'sourceDigest': self.source_digest, 'sourceAssociation': 'USER_DECLARED',
                'responseDigest': fingerprint(output) if status == 'completed' else None}}}
