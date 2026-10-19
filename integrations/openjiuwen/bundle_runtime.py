"""Validated multi-entry archive. The bundle is not a concatenated Skill."""
import base64
import hashlib
import io
from pathlib import PurePosixPath
import re
import zipfile


def safe_path(name):
    return (isinstance(name, str) and bool(name) and len(name) <= 240 and
            not any(c in name for c in ('\\', ':')) and not any(ord(c) < 32 for c in name) and
            not any(part in ('', '.', '..') or part.endswith(('.', ' ')) or
                    re.match(r'^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)', part, re.I)
                    for part in name.split('/')))


def files_digest(files):
    value = hashlib.sha256()
    for name in sorted(files):
        value.update(name.encode('utf-8'))
        value.update(b'\0')
        value.update(files[name])
        value.update(b'\0')
    return value.hexdigest()


def verify_bundle_integrity(skill, root, workspace, workspace_inputs=()):
    """Reject edits to the frozen package and relocated copies at package paths."""
    originals = {name: value.encode('utf-8') for name, value in skill.get('files', {}).items()}
    originals.update({name: base64.b64decode(value, validate=True)
                      for name, value in skill.get('binaryFiles', {}).items()})
    input_paths = {item['path'] for item in workspace_inputs}
    for name, original in originals.items():
        loaded = root / name
        if not loaded.is_file() or loaded.read_bytes() != original:
            raise RuntimeError('Loaded bundle files were modified during execution: ' + name)
        copied = workspace / name
        # Explicit case data may intentionally shadow packaged example data.
        # A newly copied package file must retain its frozen bytes.
        if name not in input_paths and copied.exists() and (
                not copied.is_file() or copied.read_bytes() != original):
            raise RuntimeError('Frozen bundle copy was modified during execution: ' + name)


def hydrate_bundle(request, manager):
    bundle = request.get('bundle')
    if request.get('skill') is not None or not isinstance(bundle, dict):
        raise ValueError('Bundle instances require a bundle and no single Skill')
    members = bundle.get('members')
    if not isinstance(members, list) or not 2 <= len(members) <= 10:
        raise ValueError('Bundle requires 2 to 10 Skill members')
    archive = base64.b64decode(bundle.pop('archiveBase64'), validate=True)
    if len(archive) > manager.max_archive_bytes or hashlib.sha256(archive).hexdigest() != bundle.get('archiveSha256'):
        raise ValueError('Bundle archive size or digest mismatch')
    with zipfile.ZipFile(io.BytesIO(archive)) as zipped:
        entries = [entry for entry in zipped.infolist() if not entry.is_dir()]
        if len(entries) > manager.max_files or sum(e.file_size for e in entries) > manager.max_uncompressed_bytes:
            raise ValueError('Bundle exceeds expanded Runtime limits')
        files = {}
        folded = set()
        for entry in entries:
            if not safe_path(entry.filename) or entry.filename.lower() in folded or (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError('Unsafe or duplicate bundle path')
            folded.add(entry.filename.lower())
            files[entry.filename] = zipped.read(entry)
    if files_digest(files) != bundle.get('digest'):
        raise ValueError('Bundle content digest mismatch')
    ids, names, paths = set(), set(), set()
    for member in members:
        entry = member.get('skillFile')
        if (not safe_path(entry) or PurePosixPath(entry).name != 'SKILL.md' or entry not in files or
                not re.fullmatch(r'[a-z0-9-]+', member.get('id', '')) or
                not isinstance(member.get('skillId'), str) or not member['skillId'] or
                not isinstance(member.get('version'), str) or not member['version']):
            raise ValueError('Invalid bundle member')
        if member['id'] in ids or member['skillId'].lower() in names or entry in paths:
            raise ValueError('Duplicate bundle member')
        ids.add(member['id'])
        names.add(member['skillId'].lower())
        paths.add(entry)
        prefix = entry[:-len('SKILL.md')]
        if any(m['skillFile'] != entry and m['skillFile'].startswith(prefix) for m in members):
            raise ValueError('Nested bundle member')
        if files_digest({name: content for name, content in files.items() if name.startswith(prefix)}) != member.get('artifactSha256'):
            raise ValueError('Bundle member content digest mismatch')
        files[entry].decode('utf-8')
    if paths != {name for name in files if name == 'SKILL.md' or name.endswith('/SKILL.md')}:
        raise ValueError('Bundle manifest does not cover every Skill entry')
    text, binary = {}, {}
    for name, content in files.items():
        try:
            text[name] = content.decode('utf-8')
        except UnicodeDecodeError:
            binary[name] = base64.b64encode(content).decode()
    entry = bundle.get('entryInstructionsFile')
    if entry and (not safe_path(entry) or entry not in text):
        raise ValueError('Agent entry instructions are missing')
    # Internal package view for existing script/MCP launching; SkillUseRail loads all members.
    request['skill'] = {'skillId': 'bundle', 'version': 'frozen', 'artifactSha256': bundle['digest'],
                        'files': text, 'binaryFiles': binary, 'instructions': '', 'bundleMembers': members}
    request['variant'] = {'mode': 'skill_version', 'skillId': 'bundle', 'version': 'frozen', 'artifactSha256': bundle['digest']}
