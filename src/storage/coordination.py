"""Process ownership on the existing shared durable filesystem.

OS locks deliberately have no time-based expiry: a slow/partitioned writer
must not lose ownership while it can still write. Process death releases the
lock. Tokens are valid only in the bridge process holding that lock.
"""
import hashlib
import os
from pathlib import Path
import uuid

from filelock import FileLock, Timeout


class CoordinationConflict(RuntimeError):
    status = 409


_held = {}


def lock_path(root, key):
    text = str(root)
    if os.name == 'nt' and text.startswith('\\\\?\\UNC\\'):
        text = '\\\\' + text[8:]
    elif os.name == 'nt' and text.startswith('\\\\?\\'):
        text = text[4:]
    root = Path(text).resolve()
    if not root.is_absolute() or not isinstance(key, str) or not 0 < len(key) <= 200:
        raise ValueError('Invalid coordination scope')
    directory = root / 'coordination'
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    return directory / (hashlib.sha256(key.encode()).hexdigest() + '.lock')


def assert_owned(root, key, token):
    entry = _held.get(token)
    if not entry or entry[0] != os.path.normcase(str(lock_path(root, key))) or not entry[1].is_locked:
        raise CoordinationConflict('任务写入归属已失效，请刷新后重试')


def execute(request):
    root = Path(request['root'])
    if not root.is_absolute():
        raise ValueError('Storage root must be absolute')
    path = lock_path(root, request['key'])
    action = request['action']
    if action == 'busy':
        if any(item[0] == os.path.normcase(str(path)) for item in _held.values()):
            return True
        lock = FileLock(str(path), timeout=0, thread_local=False)
        try:
            lock.acquire()
        except Timeout:
            return True
        lock.release()
        return False
    if action == 'acquire':
        identity = os.path.normcase(str(path))
        if any(item[0] == identity for item in _held.values()):
            return None
        lock = FileLock(str(path), timeout=0, thread_local=False)
        try:
            lock.acquire()
        except Timeout:
            return None
        token = uuid.uuid4().hex
        _held[token] = (identity, lock)
        return token
    if action == 'release':
        assert_owned(root, request['key'], request['token'])
        _, lock = _held.pop(request['token'])
        lock.release()
        return None
    if action == 'verify':
        assert_owned(root, request['key'], request['token'])
        return True
    raise ValueError('Unknown coordination action')
