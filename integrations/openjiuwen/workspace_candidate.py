"""Bind an Agent's editable directory to a frozen task snapshot.

Unfinished files are committed to the task's private Git repository before a
different snapshot is materialized. A small journal recovers an interrupted
directory replacement; it is not another version store.
"""
import base64
import json
import os
from pathlib import Path
import re
import shutil
import stat
import tempfile
from uuid import uuid4

from assets.snapshot import files_digest, validate_files
from storage.git import read as read_git_snapshot, save as save_git_snapshot

try:
    from .agent_protocol import populate_workspace
except ImportError:
    from agent_protocol import populate_workspace


def _atomic_json(path, value):
    fd, name = tempfile.mkstemp(prefix='.binding-', dir=path.parent)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(name, path)


def _candidate_files(candidate):
    files, empty_directories, modes, size = {}, [], {}, 0
    if not candidate.exists():
        return files, empty_directories, modes
    def walk_error(error):
        raise error
    for directory, folders, names in os.walk(candidate, followlinks=False, onerror=walk_error):
        folders.sort()
        names.sort()
        location = Path(directory)
        relative = location.relative_to(candidate).as_posix()
        if relative != '.' and not folders and not names:
            empty_directories.append(relative)
        if relative != '.':
            modes[relative + '/'] = stat.S_IMODE(location.stat().st_mode)
        for name in folders + names:
            if (Path(directory) / name).is_symlink():
                raise ValueError('Cannot preserve a candidate containing symbolic links')
        for name in names:
            path = Path(directory) / name
            if not path.is_file():
                raise ValueError('Cannot preserve a non-file candidate entry')
            size += path.stat().st_size
            if size > 32 * 1024 * 1024 or len(files) >= 1000:
                raise ValueError('Candidate file exceeds preservation limit')
            relative_file = path.relative_to(candidate).as_posix()
            modes[relative_file] = stat.S_IMODE(path.stat().st_mode)
            files[relative_file] = base64.b64encode(path.read_bytes()).decode('ascii')
    if files:
        validate_files(files)
    return files, empty_directories, modes


def _remove_archived(workspace, old):
    if old.is_symlink() or old.resolve().parent != workspace.resolve() or not re.fullmatch(r'candidate-old-[a-f0-9]{32}', old.name):
        raise ValueError('Invalid temporary candidate path')
    def readonly(function, path, _error):
        os.chmod(path, stat.S_IWRITE)
        function(path)
    shutil.rmtree(old, onerror=readonly)


def _recover(workspace, git_root, task_id):
    journal = workspace / '.candidate-transition.json'
    if not journal.exists():
        return
    if journal.is_symlink() or not journal.is_file():
        raise ValueError('Invalid candidate transition')
    value = json.loads(journal.read_text(encoding='utf-8'))
    if (not isinstance(value, dict) or not re.fullmatch(r'candidate-stage-[a-f0-9]{32}', str(value.get('stage', '')))
            or not re.fullmatch(r'candidate-old-[a-f0-9]{32}', str(value.get('old', '')))
            or not isinstance(value.get('binding'), dict)):
        raise ValueError('Invalid candidate transition')
    candidate, stage, old = workspace / 'candidate', workspace / value['stage'], workspace / value['old']
    if any(path.is_symlink() for path in (candidate, stage, old)):
        raise ValueError('Invalid candidate transition path')
    if candidate.is_dir() and stage.is_dir() and not old.exists():
        os.replace(candidate, old)
    if not candidate.exists() and stage.is_dir() and old.is_dir():
        os.replace(stage, candidate)
    if candidate.is_dir() and not stage.exists() and old.is_dir():
        current, empty_directories, modes = _candidate_files(old)
        record, marker = value.get('draft'), value.get('marker')
        if record:
            if not isinstance(marker, str) or not re.fullmatch(r'\.finance-task-preservation-[a-f0-9]{32}\.json', marker):
                raise ValueError('Invalid preserved-work marker')
            expected = dict(current)
            expected[marker] = base64.b64encode(json.dumps({'emptyDirectories': empty_directories, 'modes': modes},
                ensure_ascii=False, sort_keys=True).encode('utf-8')).decode('ascii')
            restored = read_git_snapshot(Path(git_root), task_id, record)
            if restored['files'] != expected:
                raise ValueError('Preserved work no longer matches the original directory')
        elif current or empty_directories:
            raise ValueError('Unfinished work was not preserved')
        _atomic_json(workspace / '.candidate-binding.json', value['binding'])
        _remove_archived(workspace, old)
        journal.unlink()
        return
    if candidate.is_dir() and not stage.exists() and not old.exists():
        binding = workspace / '.candidate-binding.json'
        if binding.is_file() and not binding.is_symlink() and json.loads(binding.read_text(encoding='utf-8')) == value['binding']:
            journal.unlink()
            return
    raise ValueError('Candidate transition requires recovery')


def prepare_candidate(workspace: Path, git_root: Path, task_id: str, attempt_id: str,
                      base_digest: str, files: dict[str, bytes], *, answering=False):
    if not isinstance(attempt_id, str) or not re.fullmatch(r'attempt-[a-f0-9-]+', attempt_id):
        raise ValueError('Invalid attempt identity')
    workspace = Path(workspace).resolve(strict=True)
    _recover(workspace, git_root, task_id)
    binding_path = workspace / '.candidate-binding.json'
    if binding_path.is_symlink():
        raise ValueError('Invalid candidate binding')
    binding = json.loads(binding_path.read_text(encoding='utf-8')) if binding_path.exists() else None
    desired = {name: base64.b64encode(value).decode('ascii') for name, value in files.items()}
    if desired:
        validate_files(desired)
    desired_digest = files_digest(desired)
    new_binding = {'attemptId': attempt_id, 'baseDigest': base_digest, 'inputDigest': desired_digest}
    if binding and binding.get('attemptId') == attempt_id:
        if binding.get('baseDigest') != base_digest:
            raise ValueError('Attempt baseline changed')
        return
    if answering:
        raise ValueError('Question belongs to another attempt or its workspace binding is missing')
    candidate = workspace / 'candidate'
    if candidate.is_symlink():
        raise ValueError('Invalid candidate directory')
    candidate.mkdir(exist_ok=True)
    current, empty_directories, modes = _candidate_files(candidate)
    if current == desired:
        _atomic_json(binding_path, new_binding)
        return
    record, marker = None, None
    if current or empty_directories:
        saved_files = dict(current)
        marker = '.finance-task-preservation-' + uuid4().hex + '.json'
        saved_files[marker] = base64.b64encode(json.dumps({'emptyDirectories': empty_directories, 'modes': modes},
            ensure_ascii=False, sort_keys=True).encode('utf-8')).decode('ascii')
        validate_files(saved_files)
        draft = {'digest': files_digest(saved_files), 'members': [], 'files': saved_files}
        record = save_git_snapshot(Path(git_root), task_id, 'candidate-' + uuid4().hex, draft)
        if read_git_snapshot(Path(git_root), task_id, record) != draft:
            raise ValueError('Failed to preserve unfinished work')
    token = uuid4().hex
    stage, old = workspace / ('candidate-stage-' + token), workspace / ('candidate-old-' + token)
    stage.mkdir()
    populate_workspace(stage, files)
    _atomic_json(workspace / '.candidate-transition.json', {'stage': stage.name, 'old': old.name,
                 'binding': new_binding, 'draft': record, 'marker': marker})
    _recover(workspace, git_root, task_id)
