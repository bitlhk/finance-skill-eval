"""Validate and freeze migration workspaces using the original digest format."""
import base64
import hashlib
import io
import json
import re
import sys
import zipfile

import yaml


class SnapshotError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class SourceLoader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        keys = set()
        for key_node, _ in node.value:
            key = self.construct_object(key_node, deep=deep)
            try:
                if key in keys:
                    raise yaml.constructor.ConstructorError(None, None, 'duplicate mapping key', key_node.start_mark)
                keys.add(key)
            except TypeError:
                raise yaml.constructor.ConstructorError(None, None, 'invalid mapping key', key_node.start_mark) from None
        return super().construct_mapping(node, deep=deep)


SourceLoader.yaml_implicit_resolvers = {key: [(tag, pattern) for tag, pattern in values
                                               if tag not in ('tag:yaml.org,2002:timestamp', 'tag:yaml.org,2002:bool')]
                                        for key, values in yaml.SafeLoader.yaml_implicit_resolvers.items()}
SourceLoader.add_implicit_resolver('tag:yaml.org,2002:bool', re.compile(r'^(?:true|True|TRUE|false|False|FALSE)$'), list('tTfF'))


def js_length(value):
    return len(value.encode('utf-16-le', errors='surrogatepass')) // 2


def js_slice(value, count):
    return value.encode('utf-16-le', errors='surrogatepass')[:count * 2].decode('utf-16-le', errors='surrogatepass')


def utf8(value):
    return value.encode('utf-16-le', errors='surrogatepass').decode('utf-16-le', errors='replace').encode('utf-8')


def validate_path(name):
    if (not isinstance(name, str) or not 0 < js_length(name) <= 240 or '\\' in name or ':' in name
            or re.search(r'[\x00-\x1f]', name)):
        raise SnapshotError('路径必须位于工程内')
    for part in name.split('/'):
        if (part in ('', '.', '..') or part.endswith(('.', ' '))
                or re.match(r'^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)', part, re.I)):
            raise SnapshotError('路径必须位于工程内')


def decode_content(value):
    if not isinstance(value, str):
        raise SnapshotError('文件内容编码无效')
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise SnapshotError('文件内容编码无效') from None
    if base64.b64encode(raw).decode('ascii') != value:
        raise SnapshotError('文件内容编码无效')
    return raw


def validate_files(files):
    if not isinstance(files, dict) or not 0 < len(files) <= 1000:
        raise SnapshotError('整组文件数必须为 1–1000')
    seen, size = set(), 0
    for name, value in files.items():
        validate_path(name)
        lowered = name.lower()
        if lowered in seen:
            raise SnapshotError('存在大小写冲突的路径')
        seen.add(lowered)
        size += len(decode_content(value))
    if size > 32 * 1024 * 1024:
        raise SnapshotError('整组解压内容超过 32 MB')


def files_digest(files, sort_key=utf8):
    digest = hashlib.sha256()
    for name in sorted(files, key=sort_key):
        digest.update(utf8(name))
        digest.update(b'\0')
        digest.update(decode_content(files[name]))
        digest.update(b'\0')
    return digest.hexdigest()


def source_frontmatter(content, source_only=False):
    escaped = source_only and content.startswith('\\---')
    candidate = content[1:] if escaped else content
    match = re.match(r'^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s|$)', candidate)
    if not match:
        raise SnapshotError('SKILL.md 缺少 YAML 头部')
    header = match.group(1)
    try:
        metadata = yaml.load(header, Loader=SourceLoader)
        if (isinstance(metadata, dict) and isinstance(metadata.get('name'), str) and metadata['name'].strip()
                and isinstance(metadata.get('description'), str) and metadata['description'].strip()):
            result = {'name': metadata['name'].strip(), 'description': metadata['description']}
            if escaped:
                result['warnings'] = ['源文件的头部分隔符被转义；原文件未修改，生成结果须修正。']
            return result
    except yaml.YAMLError:
        pass
    if source_only:
        normalized = header.replace('\r', '')
        names = list(re.finditer(r'^name:[ \t]*(.+)$', normalized, re.M))
        descriptions = list(re.finditer(r'^description:[ \t]*$', normalized, re.M))
        if len(names) == len(descriptions) == 1:
            try:
                name = yaml.load('name: ' + names[0].group(1), Loader=SourceLoader)['name']
            except (yaml.YAMLError, KeyError, TypeError):
                name = None
            rest = normalized[descriptions[0].end():]
            description = re.split(r'\n(?:license|metadata|compatibility|allowed-tools|version|name):', rest)[0].strip()
            if isinstance(name, str) and name.strip() and description and not re.match(r'^[-\[\]{}]', description):
                return {'name': name.strip(), 'description': description,
                        'warnings': ['源 SKILL.md 头部格式不合法；仅识别明确的名称和说明以便诊断，原文件未修改。生成结果须修正格式。']}
    raise SnapshotError('SKILL.md 头部格式不合法，或缺少明确的 name/description')


def read_text(files, name):
    if name not in files:
        raise SnapshotError('缺少文件：' + name)
    return decode_content(files[name]).decode('utf-8', errors='strict')


def make_snapshot(files, version, previous=None, project=False):
    validate_files(files)
    if project:
        return {'digest': files_digest(files), 'members': [], 'files': files}
    entries = sorted((name for name in files if re.search(r'(^|/)SKILL\.md$', name)),
                     key=lambda name: name.encode('utf-16-be', errors='surrogatepass'))
    if not entries:
        raise SnapshotError('工程中需要至少一个 SKILL.md 入口')
    members = []
    for index, skill_file in enumerate(entries):
        metadata = source_frontmatter(read_text(files, skill_file), previous is None)
        if js_length(metadata['name']) > 200:
            raise SnapshotError('Skill 名称过长')
        root = skill_file[:-len('SKILL.md')]
        if any(other != skill_file and other.startswith(root) for other in entries):
            raise SnapshotError('Skill 入口不能相互嵌套，请调整目录')
        digest = files_digest({name: value for name, value in files.items() if name.startswith(root)})
        old = next((member for member in (previous or {}).get('members', []) if member['skillFile'] == skill_file), None)
        member = {'id': old['id'] if old else 'skill-' + str(index + 1), 'skillId': metadata['name'],
                  'skillFile': skill_file, 'version': old['version'] if old and old['artifactSha256'] == digest else version,
                  'artifactSha256': digest}
        if metadata.get('warnings'):
            member['sourceWarnings'] = metadata['warnings']
        members.append(member)
    if len({member['skillId'].lower() for member in members}) != len(members):
        raise SnapshotError('Skill 名称重复，请先明确各成员名称')
    if previous and (len(members) != len(previous['members']) or any(
            not any(item['skillFile'] == member['skillFile'] for item in members) for member in previous['members'])):
        raise SnapshotError('整组候选必须保留全部已登记 Skill 入口', 409)
    return {'digest': files_digest(files), 'members': members, 'files': files}


def decode_zip(encoded):
    raw = decode_content(encoded)
    if not raw or len(raw) > 8 * 1024 * 1024:
        raise SnapshotError('整组 ZIP 不得超过 8 MB')
    files, seen, size = {}, set(), 0
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        for item in archive.infolist():
            if item.filename.endswith('/'):
                continue
            name = item.filename
            validate_path(name)
            if name.lower() in seen:
                raise SnapshotError('ZIP 路径重复')
            seen.add(name.lower())
            size += item.file_size
            if size > 32 * 1024 * 1024 or len(seen) > 1000:
                raise SnapshotError('ZIP 超过解压限制')
            files[name] = base64.b64encode(archive.read(item)).decode('ascii')
    validate_files(files)
    return files


def describe(source):
    descriptions = []
    for member in source['members']:
        metadata = source_frontmatter(read_text(source['files'], member['skillFile']), True)
        descriptions.append(member['skillId'] + '：' + js_slice(metadata['description'].strip(), 600))
    names = '、'.join(member['skillId'] for member in source['members'])
    return {'name': js_slice(names, 110) + ' 迁移' if names else 'Agent 工程迁移',
            'goal': '完成企业标准化，解除特定 Agent 框架耦合，保留原 Skill 的完整业务能力、工具行为及实际调用链。仅做必要改造，使同一份产物能被不同框架快速复用。以下源描述须结合源码核实，未知事实明确记录：\n' + '\n'.join(descriptions),
            'target': '交付框架无关的 Skill 和可独立调用的工具。结合实际场景比较 Script、MCP、CLI 的能力、改造、部署与维护成本，已有合格形式优先评估复用。声明运行条件，具体 Runtime 仅用于接入和验证，不以其私有实现定义迁移目标。'}


def execute(request):
    action = request['action']
    if action == 'snapshot':
        return make_snapshot(request['files'], request['version'], request.get('previous'), request.get('project', False))
    if action == 'decode':
        return decode_zip(request['archive'])
    if action == 'digest':
        return files_digest(request['files'])
    if action == 'validate':
        validate_files(request['files'])
        return None
    if action == 'describe':
        return describe(request['source'])
    if action == 'diff':
        before, after = request['before'], request['after']
        names = sorted(set(before) | set(after), key=lambda name: name.encode('utf-16-be', errors='surrogatepass'))
        return [{'path': name, 'kind': 'ADDED' if name not in before else 'REMOVED' if name not in after else 'CHANGED'}
                for name in names if before.get(name) != after.get(name)]
    raise ValueError('Unknown migration snapshot action')


def main():
    try:
        result = {'ok': True, 'value': execute(json.load(sys.stdin))}
    except SnapshotError as error:
        result = {'ok': False, 'message': str(error), 'status': error.status}
    except Exception as error:
        result = {'ok': False, 'message': str(error), 'status': 400}
    json.dump(result, sys.stdout, ensure_ascii=True, allow_nan=False)


if __name__ == '__main__':
    main()
