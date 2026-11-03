"""Bounded final-workspace evidence, excluding unchanged case fixtures and links."""
import hashlib


def workspace_digests(root):
    return {path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in root.rglob('*') if not path.is_symlink() and path.is_file() and path.stat().st_size <= 64000
            and not any(parent.is_symlink() for parent in path.parents)}


def collect_artifacts(root, fixtures=(), initial=None):
    original = {file['path']: file['content'].encode('utf-8') for file in fixtures}
    files, omitted, budget = [], 0, 32000
    for path in sorted(root.rglob('*')):
        if path.is_symlink() or not path.is_file() or any(parent.is_symlink() for parent in path.parents):
            continue
        relative = path.relative_to(root).as_posix()
        if path.stat().st_size > 64000:
            omitted += 1
            continue
        data = path.read_bytes()
        if (initial or {}).get(relative) == hashlib.sha256(data).hexdigest():
            continue
        if original.get(relative) == data:
            continue
        if len(files) >= 16 or len(data) > budget:
            omitted += 1
            continue
        try:
            content = data.decode('utf-8')
        except UnicodeDecodeError:
            omitted += 1
            continue
        budget -= len(data)
        files.append({'path': relative, 'content': content, 'sha256': hashlib.sha256(data).hexdigest(), 'source': 'runtime-workspace'})
    return files, omitted
