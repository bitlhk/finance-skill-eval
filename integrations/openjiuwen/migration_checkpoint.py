"""Private, unaccepted engineering drafts for retrying an interrupted Agent run."""
import hashlib
import json
import os
import re
import tempfile
from uuid import uuid4
from pathlib import Path

from assets.snapshot import files_digest
from storage.git import read as read_git_snapshot, save as save_git_snapshot

_MAX_DRAFT_BYTES = 150 * 1024 * 1024


def checkpoint_identity(bundle, asset_digest):
    # A retry may only reuse work for the exact same source, goal, plan and feedback.
    relevant = {key: bundle.get(key) for key in (
        'mode', 'source', 'base', 'goal', 'target', 'analysis', 'feedback',
        'project', 'adjustmentCapabilities', 'standardizationGuide')}
    relevant['assetDigest'] = asset_digest
    encoded = json.dumps(relevant, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
    return hashlib.sha256(encoded).hexdigest()


def _files_digest(files):
    encoded = json.dumps(files, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()
    return hashlib.sha256(encoded).hexdigest()


class MigrationCheckpoint:
    def __init__(self, root, task_id, attempt_id, identity):
        if not re.fullmatch(r'bundle-[a-f0-9-]+', task_id) or not re.fullmatch(r'attempt-[a-f0-9-]+', attempt_id):
            raise ValueError('Invalid checkpoint correlation')
        self.root = Path(root).resolve()
        self.task_id = task_id
        self.directory = self.root / 'migration-agent-drafts' / task_id
        self.attempt_id = attempt_id
        self.identity = identity

    def load(self, attempt_id):
        if not isinstance(attempt_id, str) or not re.fullmatch(r'attempt-[a-f0-9-]+', attempt_id):
            return None
        path = self.directory / (attempt_id + '.json')
        try:
            # Drafts use the same size limits as archives, with room for base64.
            if path.stat().st_size > _MAX_DRAFT_BYTES:
                return None
            data = json.loads(path.read_text(encoding='utf-8'))
            if data.get('identity') != self.identity or not isinstance(data.get('git'), dict):
                return None
            files = read_git_snapshot(self.root, self.task_id, data['git'])['files']
            if data.get('filesDigest') != _files_digest(files):
                return None
            return files
        except (OSError, ValueError, TypeError, RuntimeError, KeyError):
            return None

    def save(self, files):
        encoded = json.dumps(files, ensure_ascii=False).encode('utf-8')
        if len(encoded) > _MAX_DRAFT_BYTES:
            raise ValueError('Engineering draft exceeds checkpoint size limit')
        frozen = {'digest': files_digest(files), 'members': [], 'files': files}
        record = save_git_snapshot(self.root, self.task_id, 'candidate-' + uuid4().hex, frozen)
        self.directory.mkdir(parents=True, exist_ok=True)
        target = self.directory / (self.attempt_id + '.json')
        fd, name = tempfile.mkstemp(prefix='.draft-', suffix='.tmp', dir=self.directory)
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump({'identity': self.identity, 'filesDigest': _files_digest(files), 'git': record}, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, target)
        finally:
            try:
                os.unlink(name)
            except FileNotFoundError:
                pass
