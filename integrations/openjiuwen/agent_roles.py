"""Trusted, versioned role guidance. Skills are loaded eagerly, not discovered in task files."""
from dataclasses import dataclass
import hashlib
import json
from pathlib import Path
import re

ROLE_ROOT = Path(__file__).resolve().parents[2] / 'agent-roles'
MODES = {'ANALYZE': 'diagnosis', 'GENERATE': 'migration', 'REPAIR': 'migration', 'REVIEW': 'standardization-review'}
READ_TOOLS = {'read_file', 'glob', 'list_files', 'grep', 'submit_result', 'record_result', 'correct_result'}
WRITE_TOOLS = {'write_file', 'edit_file', 'compile_source', 'run_contract_test', 'run_mcp_contract_suite'}


def digest(value):
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


@dataclass(frozen=True)
class AgentRole:
    role: str
    version: str
    definition: dict
    resources: list
    prompt: str
    guidance: str
    contract: str

    def validate_tools(self, names):
        actual = set(names)
        required = set(self.definition['tools'])
        allowed = required | set(self.definition['conditionalTools'])
        if len(actual) != len(names) or not required <= actual or not actual <= allowed:
            raise ValueError('Actual tools differ from agent role permissions: missing=' +
                             ','.join(sorted(required - actual)) + '; unexpected=' + ','.join(sorted(actual - allowed)))

    def receipt(self, body, bound, tools):
        # Hash input/configuration; never persist their raw values here.
        return {'schemaVersion': 'finance.agent-composition.v1', 'role': self.role, 'version': self.version, 'configurationSource': 'RESOLVED',
                'definitionDigest': digest(json.dumps({'definition': self.definition, 'resources': self.resources}, ensure_ascii=False, separators=(',', ':'))),
                'resources': self.resources, 'tools': tools, 'writeScope': self.definition['writeScope'],
                'inputDigest': digest(json.dumps({'request': {k: v for k, v in body.items() if k not in ('model', 'files')}, 'files': body['files']}, ensure_ascii=False, sort_keys=True)),
                'model': {'providerId': body['model'].get('providerId', ''), 'modelId': body['model']['modelId'],
                          'configurationDigest': digest(json.dumps({'model': body['model'], 'resolvedModel': bound.get('upstreamModelId'), 'temperature': float(body.get('temperature', 0.2)),
                              'maxTokens': body.get('maxTokens', 32000)}, sort_keys=True))},
                'budget': {'kind': 'agentIterations', 'maxIterations': int(body.get('maxIterations', 120)),
                           'timeoutMs': int(body.get('modelTimeoutMs', 300000)), 'maxTokens': int(body.get('maxTokens', 32000))}}


def load_bundle_role(mode, version='v1', adjustment_capabilities=None):
    if mode not in MODES:
        raise ValueError('Unknown bundle role')
    if adjustment_capabilities is not None:
        if (mode != 'REPAIR' or not isinstance(adjustment_capabilities, list) or not adjustment_capabilities
                or any(not isinstance(c, str) or c not in ('document', 'tool', 'runtime') for c in adjustment_capabilities)
                or len(set(adjustment_capabilities)) != len(adjustment_capabilities)):
            raise ValueError('Invalid adjustment assembly')
        return load_role('adjustment', version, profile='engineering', capabilities=adjustment_capabilities, mode=mode)
    return load_role(MODES[mode], version, mode=mode)


def load_role(role, version='v1', *, profile=None, capabilities=None, mode=None):
    if role not in {*MODES.values(), 'adjustment'} or not re.fullmatch(r'v[1-9][0-9]*', version):
        raise ValueError('Unknown agent role/version')
    if profile not in {None, 'engineering'}:
        raise ValueError('Unknown agent execution profile')
    if profile == 'engineering' and role != 'adjustment':
        raise ValueError('Profile does not belong to this role')
    root = (ROLE_ROOT / version).resolve(strict=True)

    def read(relative):
        file = (root / relative).resolve(strict=True)
        if not file.is_relative_to(root):
            raise ValueError('Agent resource escapes trusted root')
        return file.read_text(encoding='utf-8')

    manifest = json.loads(read('roles.json'))
    if manifest['schemaVersion'] != 'finance.agent-roles.v1' or manifest['version'] != version:
        raise ValueError('Agent version mismatch')
    base = manifest['roles'][role]
    definition = dict(base)
    if profile:
        selected = base['executionProfiles'][profile]
        definition.update(selected)
        definition['skills'] = (base['skills'] if role == 'adjustment' else []) + selected.get('skills', [])
    if role == 'adjustment':
        if profile != 'engineering' or not capabilities or any(c not in base['capabilitySkills'] for c in capabilities):
            raise ValueError('Invalid adjustment assembly')
        definition['skills'] += [path for capability in capabilities for path in base['capabilitySkills'][capability]]
    writable = role in ('migration', 'adjustment')
    ceiling = READ_TOOLS | (WRITE_TOOLS if writable else set())
    if role == 'diagnosis':
        ceiling |= {'run_scanner'}
    if (definition['executor'] != 'openjiuwen-bundle' or (mode and mode not in definition['modes'])
            or definition['writeScope'] != ('candidate' if writable else 'none')
            or not set(definition['tools'] + definition['conditionalTools']) <= ceiling):
        raise ValueError('Agent definition exceeds executable permissions')
    paths = [definition['prompt']] + definition['skills'] + definition['references']
    resources = [{'path': path, 'sha256': digest(read(path))} for path in paths]
    return AgentRole(role, version, definition, resources, read(definition['prompt']),
                      '\n'.join(read(path) for path in definition['skills']),
                      '\n'.join(read(path) for path in definition['references']))
