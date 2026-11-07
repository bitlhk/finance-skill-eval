"""Skill asset storage, preserving the platform's original asset layout and digests."""
import base64
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import re
import uuid
import zipfile

import yaml

from storage.tasks import filesystem_path, read_json, write_json


def archive_entries(encoded):
    data = base64.b64decode(encoded, validate=True)
    if not 0 < len(data) <= 8 * 1024 * 1024:
        raise ValueError('Skill ZIP 大小必须在 1 字节到 8 MB 之间')
    result = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        files = [item for item in archive.infolist() if not item.is_dir()]
        if not files or len(files) > 200 or sum(item.file_size for item in files) > 16 * 1024 * 1024:
            raise ValueError('Skill ZIP 超过解压限制')
        for item in files:
            name = item.filename.replace('\\', '/')
            if name.startswith('./'):
                name = name[2:]
            if not name or name.startswith('/') or '..' in name.split('/') or re.match(r'^[A-Za-z]:', name):
                raise ValueError('Unsafe Skill archive path: ' + name)
            if name in result:
                raise ValueError('Duplicate archive paths')
            result[name] = archive.read(item)
    return result


def ordered_files(files, order):
    if not isinstance(order, list) or len(order) != len(files) or len(set(order)) != len(files) or set(order) != set(files):
        raise ValueError('Asset file ordering does not match the actual files')
    return [(name, files[name]) for name in order]


def file_identity(files):
    from assets.snapshot import files_digest
    return files_digest({name: base64.b64encode(content).decode('ascii') for name, content in files.items()})


def saved_order(root, item, request):
    try:
        return read_json(root / 'skills' / 'orders' / (item['assetId'] + '.json'))
    except FileNotFoundError:
        index = Path(request.get('legacyOrderIndex') or root / 'native-asset-orders.json')
        try:
            return read_json(index).get('assets', {}).get(item['artifactSha256'])
        except FileNotFoundError:
            return None


def save_order(root, asset_id, files, order):
    write_json(root / 'skills' / 'orders' / (asset_id + '.json'),
               {'order': order, 'filesDigest': file_identity(files)})


def digest(entries):
    payload = [{'content': base64.b64encode(data).decode('ascii'), 'name': name} for name, data in entries]
    encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    return hashlib.sha256(encoded).hexdigest()


def valid_id(asset_id):
    return isinstance(asset_id, str) and re.fullmatch(r'[a-z0-9-]+', asset_id) is not None


def record(root, asset_id):
    if not valid_id(asset_id):
        return None
    try:
        return read_json(root / 'skills' / 'records' / (asset_id + '.json'))
    except FileNotFoundError:
        return None


def stored_files(root, asset_id):
    if record(root, asset_id) is None:
        raise ValueError('Unknown Skill asset: ' + str(asset_id))
    directory = root / 'skills' / 'assets' / asset_id
    result = {}
    for parent, directories, filenames in os.walk(directory, followlinks=False):
        for name in directories + filenames:
            if (Path(parent) / name).is_symlink():
                raise ValueError('Skill 包不能包含符号链接')
        for name in filenames:
            file = Path(parent) / name
            if file.is_file():
                result[file.relative_to(directory).as_posix()] = file.read_bytes()
    return result


def frontmatter(source):
    match = re.match(r'^---[^\S\r\n]*\r?\n([\s\S]*?)\r?\n---[^\S\r\n]*(?:\r?\n|$)', source)
    if not match:
        match = re.match(r'^(name:[^\n]*\n[\s\S]{0,8000}?)\r?\n---[^\S\r\n]*(?:\r?\n|$)', source)
    if not match:
        return {}
    # The existing JavaScript YAML parser keeps timestamps as strings.
    class Loader(yaml.SafeLoader):
        pass
    Loader.yaml_implicit_resolvers = {key: [(tag, pattern) for tag, pattern in values
                                             if tag not in ('tag:yaml.org,2002:timestamp', 'tag:yaml.org,2002:bool')]
                                      for key, values in yaml.SafeLoader.yaml_implicit_resolvers.items()}
    Loader.add_implicit_resolver('tag:yaml.org,2002:bool', re.compile(r'^(?:true|True|TRUE|false|False|FALSE)$'), list('tTfF'))
    parsed = yaml.load(match.group(1), Loader=Loader)
    return parsed if isinstance(parsed, dict) else {}


def text(value):
    return value.strip() if isinstance(value, str) and value.strip() else None


def execute(request):
    root = filesystem_path(request['root'])
    if not root.is_absolute():
        raise ValueError('Storage root must be absolute')
    action = request['action']
    assets = root / 'skills' / 'assets'
    records = root / 'skills' / 'records'
    if action == 'initialize':
        assets.mkdir(parents=True, exist_ok=True)
        records.mkdir(parents=True, exist_ok=True)
        return None
    if action == 'list':
        items = [read_json(path) for path in records.glob('*.json')] if records.exists() else []
        return sorted(items, key=lambda item: item['createdAt'], reverse=True)
    if action == 'get':
        return record(root, request['id'])
    if action == 'inspectZip':
        return list(archive_entries(request['archive']))
    if action == 'upload':
        files = archive_entries(request['archive'])
        order = request.get('order')
        if order is None:
            order = sorted(files, key=lambda name: name.encode('utf-16-be'))
        entries = ordered_files(files, order)
        original_names = list(files)
        candidates = [name for name in original_names if re.search(r'(^|/)skill\.md$', name, re.I)]
        candidates.sort(key=lambda name: len(name.split('/')))
        migration = bool(request.get('migrationInput'))
        fallback = [name for name in order if re.search(r'\.(md|mdx|txt)$', name, re.I)] if migration else []
        fallback.sort(key=lambda name: len(name.split('/')))
        skill_file = ('skill/SKILL.md' if 'skill/SKILL.md' in candidates else
                      candidates[0] if candidates else fallback[0] if fallback else None)
        if not skill_file:
            raise ValueError('Migration ZIP needs a readable instruction file (.md/.mdx/.txt) anywhere in the archive'
                             if migration else 'Skill ZIP does not contain SKILL.md')
        if len(candidates) > 1 and not migration:
            raise ValueError('Skill ZIP 根目录有多个 Skill 入口：不支持一个包里放多个 Skill，请分别上传')
        source = files[skill_file].decode('utf-8', errors='replace')
        if not source.strip() and not migration:
            raise ValueError('SKILL.md 是空的')
        metadata = frontmatter(source)
        name = text(metadata.get('name'))
        preserve_from = request.get('preserveIdentityFrom')
        if preserve_from is not None:
            original = record(root, preserve_from)
            if original is None:
                raise ValueError('Original Skill asset does not exist')
            if name and name != original['skillId']:
                raise ValueError('候选不能改变 Skill 身份')
            if not name and skill_file != original['skillFile']:
                raise ValueError('缺少名称的候选必须保留原 Skill 入口')
            skill_id = original['skillId']
        else:
            skill_id = name or 'uploaded-skill-' + uuid.uuid4().hex[:8]
        version = text(request.get('version')) or text(metadata.get('version')) or '0.0.0-upload'
        if request.get('order') is None:
            identity = file_identity(files)
            for path in records.glob('*.json'):
                existing = read_json(path)
                saved = saved_order(root, existing, request)
                if (saved and saved.get('filesDigest') == identity
                        and (existing['skillId'] == skill_id or not name and preserve_from is None)):
                    legacy = ordered_files(files, saved['order'])
                    if digest(legacy) == existing['artifactSha256']:
                        return existing
        artifact = digest(entries)
        prefix = re.sub(r'[^a-z0-9]+', '-', skill_id.lower()).strip('-')[:48] or 'skill'
        asset_id = prefix + '-' + artifact[:12]
        existing = record(root, asset_id)
        if existing:
            return existing
        target = assets / asset_id
        for name, content in entries:
            destination = target.joinpath(*name.split('/'))
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
            try:
                destination.chmod(0o600)
            except OSError:
                pass
        item = {'schemaVersion': 'finance.skill-eval.skill-asset.v1', 'assetId': asset_id,
                'skillId': skill_id, 'version': version, 'displayName': text(metadata.get('displayName')) or text(metadata.get('name')) or skill_id,
                'description': text(metadata.get('description')) or '用户上传的 Skill 候选资产', 'sourceType': 'uploaded',
                'artifactSha256': artifact, 'skillFile': skill_file, 'fileCount': len(files),
                'createdAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')}
        save_order(root, asset_id, files, order)
        write_json(records / (asset_id + '.json'), item)
        return item
    asset_id = request['id']
    item = record(root, asset_id)
    if item is None:
        raise ValueError('Unknown Skill asset: ' + str(asset_id))
    if action == 'readSource':
        return (assets / asset_id / item['skillFile']).read_bytes().decode('utf-8', errors='replace')
    if action == 'readFiles':
        files = stored_files(root, asset_id)
        prefix = str(Path(item['skillFile']).parent).replace('\\', '/')
        prefix = '' if prefix == '.' else prefix + '/'
        return {name[len(prefix):]: content.decode('utf-8', errors='replace') for name, content in files.items()
                if name.startswith(prefix) and re.search(r'\.(md|txt|yaml|yml|json)$', name, re.I)}
    files = stored_files(root, asset_id)
    if action == 'archiveNames':
        return list(files)
    if action == 'readArchive':
        metadata = saved_order(root, item, request)
        order = request.get('order') or (metadata or {}).get('order')
        if order is None:
            raise ValueError('旧资产缺少已验证的文件顺序元数据，请运行历史资产迁移工具')
        entries = ordered_files(files, order)
        if len(entries) != item['fileCount'] or digest(entries) != item['artifactSha256']:
            raise ValueError('Skill 快照摘要不一致')
        if metadata is None:
            save_order(root, asset_id, files, order)
        return {name: base64.b64encode(data).decode('ascii') for name, data in entries}
    raise ValueError('Unknown asset store action')
