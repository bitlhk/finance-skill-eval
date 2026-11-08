"""Git-backed immutable file snapshots for one migration task.

The repository is private platform data, never the user's Git repository.
Git plumbing stores exact imported bytes without checkout filters or hooks.
"""
import base64
import json
import os
from pathlib import Path
import re
import subprocess
from tempfile import TemporaryFile

from filelock import FileLock

from assets.snapshot import decode_content, files_digest, validate_files


def _environment():
    # Never inherit a caller's repository, index, credential or Git config.
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith('GIT_')}
    env.update(GIT_CONFIG_NOSYSTEM='1', GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT='0')
    return env


def _git_path(path: Path) -> str:
    value = str(path)
    if os.name == 'nt' and value.startswith('\\\\?\\UNC\\'):
        value = '\\\\' + value[8:]
    elif os.name == 'nt' and value.startswith('\\\\?\\'):
        value = value[4:]
    if os.name == 'nt' and len(value) > 200 and path.exists():
        # Git for Windows can reject a long absolute GIT_DIR even with
        # core.longpaths; use the OS-provided short name when available.
        import ctypes
        buffer = ctypes.create_unicode_buffer(32768)
        length = ctypes.windll.kernel32.GetShortPathNameW(value, buffer, len(buffer))
        if 0 < length < len(buffer) and len(buffer.value) < len(value):
            return buffer.value
    return value


def _run_git(args, data=None, check=True):
    # File handles avoid Windows pipe-reader threads waiting indefinitely when
    # Git's executable shim leaves inherited handles open in a child process.
    with TemporaryFile() as incoming, TemporaryFile() as outgoing, TemporaryFile() as errors:
        if data is not None:
            incoming.write(data)
            incoming.seek(0)
        result = subprocess.run(['git', '-c', 'core.longpaths=true', '-c', 'core.protectNTFS=false', *args],
            stdin=incoming, stdout=outgoing, stderr=errors, env=_environment(), check=False, timeout=30,
            **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}))
        outgoing.seek(0)
        errors.seek(0)
        result.stdout, result.stderr = outgoing.read(), errors.read()
        if check and result.returncode:
            raise RuntimeError('Git snapshot operation failed: ' + result.stderr.decode('utf-8', 'replace')[-1000:])
        return result


def _git(repository: Path, *args, data=None):
    return _run_git(['--git-dir=' + _git_path(repository), *args], data=data).stdout


def _quoted_path(path: str) -> bytes:
    # fast-import accepts C-quoted UTF-8 bytes, including non-ASCII and quotes.
    result = bytearray(b'"')
    for byte in path.encode('utf-8'):
        if byte in (34, 92):
            result.extend(b'\\' + bytes([byte]))
        elif byte < 32 or byte >= 127:
            result.extend(('\\%03o' % byte).encode('ascii'))
        else:
            result.append(byte)
    result.extend(b'"')
    return bytes(result)


def _repo(root: Path, task_id: str) -> Path:
    if not re.fullmatch(r'bundle-[a-f0-9-]+', task_id):
        raise ValueError('Invalid task ID')
    return root / 'migration-tasks' / 'git' / (task_id + '.git')


def save(root: Path, task_id: str, revision: str, snapshot: dict, parent: str | None = None) -> dict:
    if not re.fullmatch(r'(?:source|candidate-[a-f0-9-]+)', revision):
        raise ValueError('Invalid snapshot revision')
    if parent is not None and not re.fullmatch(r'(?:source|candidate-[a-f0-9-]+)', parent):
        raise ValueError('Invalid parent revision')
    files = snapshot['files']
    validate_files(files)
    digest = files_digest(files)
    if snapshot.get('digest') != digest:
        raise ValueError('Snapshot digest does not match files')
    repository = _repo(root, task_id)
    repository.parent.mkdir(parents=True, exist_ok=True)
    lock = FileLock(str(repository.parent / (task_id + '.lock')))
    with lock:
        if not repository.exists():
            _run_git(['init', '--bare', '--quiet', _git_path(repository)])
        ref = 'refs/finance/snapshots/' + revision
        exists = _run_git(['--git-dir=' + _git_path(repository), 'show-ref', '--verify', '--quiet', ref], check=False)
        if exists.returncode == 0:
            commit = _git(repository, 'rev-parse', '--verify', ref + '^{commit}').decode('ascii').strip()
            if read_revision(root, task_id, revision) != snapshot:
                raise ValueError('Snapshot revision already exists with different content')
            record = {'storage': 'git-v1', 'commit': commit,
                      'snapshot': {key: value for key, value in snapshot.items() if key != 'files'},
                      **({'parent': parent} if parent else {})}
            if parent:
                expected = _git(repository, 'rev-parse', '--verify', 'refs/finance/snapshots/' + parent + '^{commit}').strip()
                actual = _git(repository, 'rev-parse', '--verify', commit + '^').strip()
                if actual != expected:
                    raise ValueError('Snapshot revision already exists with a different parent')
            elif len(_git(repository, 'rev-list', '--parents', '-n', '1', commit).split()) != 1:
                raise ValueError('Snapshot revision already exists with a different parent')
            if read(root, task_id, record) != snapshot:
                raise ValueError('Snapshot revision already exists with different files')
            return record
        if exists.returncode != 1:
            raise RuntimeError('Cannot check existing Git snapshot: ' + exists.stderr.decode('utf-8', 'replace')[-1000:])
        metadata = {key: value for key, value in snapshot.items() if key != 'files'}
        message = json.dumps(metadata, ensure_ascii=True, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('ascii')
        stream = bytearray(b'commit ' + ref.encode('ascii') + b'\n')
        stream.extend(b'committer Finance Platform <migration@localhost> 1 +0000\n')
        stream.extend(b'data ' + str(len(message)).encode('ascii') + b'\n' + message + b'\n')
        if parent:
            parent_ref = 'refs/finance/snapshots/' + parent
            probe = _run_git(['--git-dir=' + _git_path(repository), 'show-ref', '--verify', '--quiet', parent_ref], check=False)
            if probe.returncode == 0:
                stream.extend(b'from ' + parent_ref.encode('ascii') + b'\n')
            elif probe.returncode == 1:
                raise ValueError('Parent snapshot does not exist')
            else:
                raise RuntimeError('Cannot check parent Git snapshot')
        stream.extend(b'deleteall\n')
        for name in sorted(files, key=lambda item: item.encode('utf-8')):
            content = decode_content(files[name])
            stream.extend(b'M 100644 inline ' + _quoted_path(name) + b'\n')
            stream.extend(b'data ' + str(len(content)).encode('ascii') + b'\n' + content + b'\n')
        stream.extend(b'\ndone\n')
        _git(repository, 'fast-import', '--quiet', data=bytes(stream))
        commit = _git(repository, 'rev-parse', '--verify', ref + '^{commit}').decode('ascii').strip()
        if not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', commit):
            raise ValueError('Invalid Git snapshot identity')
        return {'storage': 'git-v1', 'commit': commit,
                'snapshot': {key: value for key, value in snapshot.items() if key != 'files'},
                **({'parent': parent} if parent else {})}


def read(root: Path, task_id: str, record: dict) -> dict:
    repository = _repo(root, task_id)
    commit = record.get('commit')
    if not isinstance(commit, str) or not re.fullmatch(r'[a-f0-9]{40}|[a-f0-9]{64}', commit):
        raise ValueError('Invalid Git snapshot identity')
    listing = _git(repository, 'ls-tree', '-r', '-z', '--full-tree', commit)
    entries = []
    for item in listing.split(b'\0'):
        if not item:
            continue
        header, name = item.split(b'\t', 1)
        mode, kind, object_id = header.split(b' ')
        if mode != b'100644' or kind != b'blob':
            raise ValueError('Unsupported Git snapshot entry')
        entries.append((name.decode('utf-8'), object_id))
    data = _git(repository, 'cat-file', '--batch', data=b''.join(oid + b'\n' for _, oid in entries))
    files, offset = {}, 0
    for name, object_id in entries:
        end = data.find(b'\n', offset)
        if end < 0:
            raise ValueError('Incomplete Git snapshot object')
        header = data[offset:end].split(b' ')
        if len(header) != 3 or header[0] != object_id or header[1] != b'blob':
            raise ValueError('Invalid Git snapshot object')
        length = int(header[2])
        start = end + 1
        content = data[start:start + length]
        if len(content) != length or data[start + length:start + length + 1] != b'\n':
            raise ValueError('Incomplete Git snapshot object')
        files[name] = base64.b64encode(content).decode('ascii')
        offset = start + length + 1
    snapshot = {**record['snapshot'], 'files': files}
    validate_files(files)
    if files_digest(files) != snapshot.get('digest'):
        raise ValueError('Git snapshot digest mismatch')
    return snapshot


def read_revision(root: Path, task_id: str, revision: str) -> dict:
    if not isinstance(revision, str) or not re.fullmatch(r'(?:source|candidate-[a-f0-9-]+)', revision):
        raise ValueError('Invalid snapshot revision')
    repository = _repo(root, task_id)
    ref = 'refs/finance/snapshots/' + revision
    commit = _git(repository, 'rev-parse', '--verify', ref + '^{commit}').decode('ascii').strip()
    metadata = json.loads(_git(repository, 'show', '-s', '--format=%B', commit))
    if not isinstance(metadata, dict) or 'files' in metadata:
        raise ValueError('Invalid Git snapshot metadata')
    return read(root, task_id, {'commit': commit, 'snapshot': metadata})
