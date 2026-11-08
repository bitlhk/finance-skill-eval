"""Skill dependency declarations, shared by catalog and Runtime assembly."""
import re
import yaml


class CaseToolOutsideDeclaration(ValueError):
    pass


def runtime_requirements(source, case_tools=(), auxiliary=()):
    cases = sorted(set(case_tools))
    match = re.match(r'^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)', source or '')
    if not match:
        return cases
    metadata = yaml.safe_load(match[1])
    if not isinstance(metadata, dict):
        raise ValueError('Skill 元数据必须为对象')
    if 'allowed-tools' in metadata and 'allowedTools' in metadata:
        raise ValueError('Skill 工具声明重复')
    if not ('allowed-tools' in metadata or 'allowedTools' in metadata):
        return cases
    raw = metadata.get('allowed-tools', metadata.get('allowedTools'))
    tools = raw if isinstance(raw, list) else re.split(r'[\s,]+', raw.strip()) if isinstance(raw, str) and raw.strip() else None
    if tools is None or len(tools) > 64 or any(not isinstance(tool, str) or not tool or tool != tool.strip() or tool == '*' for tool in tools) or len(set(tools)) != len(tools):
        raise ValueError('Skill 工具声明无效；无工具方法应明确声明 []')
    extras = set(cases) - set(tools)
    if extras - set(auxiliary):
        raise CaseToolOutsideDeclaration('案例工具不在 Skill 声明的依赖中，请核对方法版本和案例')
    return sorted(set(tools) | extras)


def describe(source):
    try:
        tools = runtime_requirements(source)
        match = re.match(r'^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)', source)
        metadata = yaml.safe_load(match[1]) if match else {}
        declared = isinstance(metadata, dict) and ('allowed-tools' in metadata or 'allowedTools' in metadata)
        return {'status': 'declared' if declared else 'unspecified', 'tools': tools}
    except (ValueError, yaml.YAMLError) as error:
        return {'status': 'invalid', 'tools': [], 'error': str(error)}
