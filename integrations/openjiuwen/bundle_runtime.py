"""Shared file-tree integrity for the SDK-internal mounted Skill view."""
import base64
import hashlib
import re


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
