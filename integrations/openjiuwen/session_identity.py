"""Stable task-session identifiers, without loading the Agent SDK."""
import hashlib
import os
from pathlib import Path
import re
import tempfile
import uuid

from filelock import FileLock


def task_session_identity(workspace_scope: str, task_id: str) -> str:
    if not workspace_scope or not task_id:
        raise ValueError('workspace scope and task ID are required')
    material = f'{len(workspace_scope)}:{workspace_scope}{len(task_id)}:{task_id}'
    return 'migration-' + hashlib.sha256(material.encode('utf-8')).hexdigest()


def persistent_workspace_scope(data_root: str | Path) -> str:
    """Return the workspace's persisted internal ID, independent of mount path.

    This is a storage namespace, not an authentication identity. The existing
    workspace authorization must still be enforced by the task service.
    """
    root = Path(data_root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    identity_file = root / 'workspace-scope'
    with FileLock(str(root / 'workspace-scope.lock'), timeout=10):
        if identity_file.exists():
            if identity_file.is_symlink():
                raise ValueError('Invalid workspace session identity')
            value = identity_file.read_text(encoding='ascii').strip()
            if not re.fullmatch(r'workspace-[a-f0-9]{32}', value):
                raise ValueError('Invalid workspace session identity')
            return value
        value = 'workspace-' + uuid.uuid4().hex
        descriptor, name = tempfile.mkstemp(prefix='.workspace-scope-', dir=root)
        try:
            with os.fdopen(descriptor, 'w', encoding='ascii') as output:
                output.write(value + '\n')
                output.flush()
                os.fsync(output.fileno())
            os.replace(name, identity_file)
        finally:
            try:
                os.unlink(name)
            except FileNotFoundError:
                pass
        return value
