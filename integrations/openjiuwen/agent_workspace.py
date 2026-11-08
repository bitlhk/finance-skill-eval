"""Durable workspace for one main Agent task.

The task host holds the workspace lock while an instance executes. The lock is
an OS file lock for processes sharing this filesystem; cross-host filesystems
must be validated separately before they are used for instance takeover.
"""

import json
import os
import posixpath
import re
import tempfile
from pathlib import Path

from filelock import FileLock

try:
    from .agent_protocol import populate_workspace
except ImportError:
    from agent_protocol import populate_workspace


def _filesystem_path(path: Path) -> Path:
    if os.name != 'nt' or not path.is_absolute():
        return path
    value = str(path)
    if value.startswith('\\\\?\\'):
        return path
    if value.startswith('\\\\'):
        return Path('\\\\?\\UNC\\' + value[2:])
    return Path('\\\\?\\' + value)


class TaskWorkspace:
    def __init__(self, data_root: str | Path, session_id: str):
        if not isinstance(session_id, str) or not re.fullmatch(r'migration-[a-f0-9]{64}', session_id):
            raise ValueError('Invalid task session ID')
        self.root = _filesystem_path(Path(data_root).expanduser().resolve() / 'migration-agent-workspaces')
        self.root.mkdir(parents=True, exist_ok=True)
        self.session_id = session_id
        self.path = self.root / session_id
        self._lock = FileLock(str(self.root / (session_id + '.lock')), timeout=0)

    def __enter__(self):
        self._lock.acquire()
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self._lock.release()

    def initialize(self, files: dict[str, str | bytes], source_digest: str) -> Path:
        if not self._lock.is_locked:
            raise RuntimeError('Task workspace must be locked')
        if not isinstance(source_digest, str) or not re.fullmatch(r'[a-f0-9]{64}', source_digest):
            raise ValueError('Invalid source digest')
        if any(posixpath.normpath(name.replace('\\', '/')) == '.task-workspace.json' for name in files):
            raise ValueError('Task workspace metadata path is reserved')
        metadata = {'sessionId': self.session_id, 'sourceDigest': source_digest}
        if self.path.exists():
            marker = self.path / '.task-workspace.json'
            if self.path.is_symlink() or not marker.is_file() or marker.is_symlink():
                raise ValueError('Task workspace is incomplete or invalid')
            if json.loads(marker.read_text(encoding='utf-8')) != metadata:
                raise ValueError('Task workspace does not match the original source')
            return self.path

        staging = Path(tempfile.mkdtemp(prefix='.workspace-', dir=self.root))
        populate_workspace(staging, files)
        (staging / '.task-workspace.json').write_text(json.dumps(metadata), encoding='utf-8')
        # Atomic publication ensures an interrupted initialisation is never
        # mistaken for a fully prepared workspace. Preserve staging on failure.
        os.rename(staging, self.path)
        return self.path
