"""Read existing versioned service bindings without reviving a retired workflow."""
import asyncio
import math
from pathlib import Path
import re
from jsonschema import Draft7Validator

from storage.tasks import read_json
from tasks.values import fingerprint
from migration.state import MigrationControlError


async def resolve_service_environment(root, reference, tool_names):
    def read():
        identifier = reference['migrationId']
        if not re.fullmatch('migration-[a-f0-9-]+', identifier):
            raise MigrationControlError('迁移记录 ID 不合法', 400)
        project = read_json(Path(root) / 'migrations' / (identifier + '.json'))
        if project.get('schemaVersion') != 'finance.skill-migration.v2':
            raise MigrationControlError('旧版迁移记录不再升级，请使用原始 Skill 新建迁移', 410)
        if project.get('id') != identifier:
            raise MigrationControlError('迁移记录 ID 与请求不一致')
        try:
            config = read_json(Path(root) / 'migration-runtime-config' / (identifier + '.json'))
        except FileNotFoundError:
            config = {'revision': 0, 'values': {}, 'checks': []}
        dependencies = (project.get('sourceInspection', {}).get('dependencyAnalysis') or {}).get('dependencies', [])
        if not project.get('candidate') or project['candidate']['artifactSha256'] != reference['assetDigest'] or config['revision'] != reference['revision'] or fingerprint([
                config['revision'], config['values'], dependencies]) != reference['configurationDigest']:
            raise MigrationControlError('服务配置或候选已变化，请重新验证')
        tools = project.get('inspection', {}).get('tools', [])
        if any(not any(tool['name'] == name for tool in tools) for name in tool_names):
            raise MigrationControlError('服务配置关联了未知工具')
        tool_ids = {tool['toolId'] for tool in tools if tool['name'] in tool_names}
        selected = [item for item in dependencies if tool_ids.intersection(item['toolIds'])]
        public, secrets, combined = {}, {}, {}
        for dependency in selected:
            binding = dependency.get('binding') or {}
            if dependency['owner'] != 'RUNTIME' or dependency['action'] != 'INJECT' or binding.get('kind') != 'SERVICE_ENV':
                continue
            if dependency['contractStatus'] != 'KNOWN':
                raise MigrationControlError('服务配置契约尚未确认：' + dependency['name'])
            if dependency['id'] not in config['values']:
                if dependency['blocking']:
                    raise MigrationControlError('请先填写服务配置：' + dependency['name'])
                continue
            value = config['values'][dependency['id']]
            schema = dependency.get('schema') or {}
            def has_ref(item):
                return isinstance(item, dict) and ('$ref' in item or any(has_ref(child) for child in item.values())) or isinstance(item, list) and any(has_ref(child) for child in item)
            if has_ref(schema) or not Draft7Validator(schema).is_valid(value) or type(value) not in (str, int, float, bool) or isinstance(value, float) and not math.isfinite(value) or value == '':
                raise MigrationControlError('服务配置格式不合法：' + dependency['name'])
            name = binding['name']
            rendered = ('true' if value else 'false') if isinstance(value, bool) else str(value)
            if not re.fullmatch('[A-Z][A-Z0-9_]{0,99}', name) or re.fullmatch(r'PORT|PATH|PATHEXT|HOME|USERPROFILE|SYSTEMROOT|COMSPEC|NODE_OPTIONS|PYTHON.*|LD_.*|DYLD_.*', name) or '\0' in rendered or len(rendered.encode()) > 128000:
                raise MigrationControlError('服务环境变量名称或值不合法')
            if name in combined and combined[name] != rendered:
                raise MigrationControlError('同一服务的环境变量配置冲突')
            combined[name] = rendered
            (secrets if dependency['sensitive'] else public)[name] = rendered
        for name in secrets:
            public.pop(name, None)
        return {'configuration': public, 'secrets': secrets}
    return await asyncio.to_thread(read)
