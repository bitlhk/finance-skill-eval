"""Persist current migration tasks and their Git-backed file versions.

Old task protocols are handled only by the read-only history service.
"""
import json
import errno
import os
from pathlib import Path
import re
import time
import uuid
import hashlib

from storage.git import read_revision as read_git_revision, save as save_git_snapshot
from storage.coordination import assert_owned, CoordinationConflict


TASK_ID = re.compile(r'bundle-[a-f0-9-]+\Z')
SCHEMA = 'finance.skill-migration.task.v3'


class TaskProtocolError(Exception):
    pass


def filesystem_path(value):
    path = Path(value)
    if os.name != 'nt' or not path.is_absolute():
        return path
    text = str(path)
    if text.startswith('\\\\?\\'):
        return path
    if text.startswith('\\\\'):
        return Path('\\\\?\\UNC\\' + text[2:])
    return Path('\\\\?\\' + text)


def task_path(root, task_id):
    if not isinstance(task_id, str) or not TASK_ID.fullmatch(task_id):
        raise ValueError('Invalid task ID')
    return root / 'migration-tasks' / 'tasks' / (task_id + '.json')


def read_json(path):
    # Atomic replacement can briefly deny a concurrent Windows reader. Retry
    # the same bounded sharing violations as the writer; corrupt JSON remains
    # an error and is never silently treated as a missing record.
    for attempt in range(51):
        try:
            with path.open(encoding='utf-8') as source:
                return json.load(source)
        except OSError as error:
            if error.errno not in (errno.EPERM, errno.EBUSY, errno.EACCES) or attempt == 50:
                raise
            time.sleep(0.01)


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        # Exclusive creation ensures another writer's temporary file is untouched.
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as output:
            json.dump(value, output, ensure_ascii=True, indent=2, allow_nan=False)
            output.write('\n')
        for attempt in range(51):
            try:
                os.replace(temporary, path)
                break
            except OSError as error:
                if error.errno not in (errno.EPERM, errno.EBUSY, errno.EACCES) or attempt == 50:
                    raise
                time.sleep(0.01)
    finally:
        temporary.unlink(missing_ok=True)


def get_task(root, task_id):
    task = read_json(task_path(root, task_id))
    if task.get('schemaVersion') != SCHEMA:
        raise TaskProtocolError('Wrong task protocol')
    return task


def versioned(task):
    encoded = json.dumps(task, sort_keys=True, ensure_ascii=True, separators=(',', ':'), allow_nan=False)
    return {'task': task, 'revision': hashlib.sha256(encoded.encode()).hexdigest()}


def execute(request):
    root = filesystem_path(request['root'])
    if not root.is_absolute():
        raise ValueError('Storage root must be absolute')
    action = request['action']
    if action in ('list', 'listVersioned'):
        directory = root / 'migration-tasks' / 'tasks'
        files = list(directory.glob('*.json')) if directory.exists() else []
        tasks = [read_json(file) for file in files]
        result = sorted((task for task in tasks if task.get('schemaVersion') == SCHEMA),
                        key=lambda task: task['createdAt'], reverse=True)
        return [versioned(task) for task in result] if action == 'listVersioned' else result
    task_id = request['id']
    if action == 'get':
        return get_task(root, task_id)
    if action == 'getVersioned':
        return versioned(get_task(root, task_id))
    if action == 'saveVersioned':
        assert_owned(root, 'task-write:' + task_id, request.get('writeToken'))
        if request.get('executionToken'):
            assert_owned(root, 'task-execution:' + task_id, request['executionToken'])
        path = task_path(root, task_id)
        actual = versioned(get_task(root, task_id))['revision'] if path.exists() else None
        if request.get('expectedRevision') != actual:
            raise CoordinationConflict('任务已被其他请求更新，请刷新后重试')
        if request['value'].get('id') != task_id or request['value'].get('schemaVersion') != SCHEMA:
            raise ValueError('Invalid task identity or protocol')
        write_json(path, request['value'])
        return versioned(request['value'])['revision']
    if action == 'readSnapshot':
        get_task(root, task_id)
        return read_git_revision(root, task_id, request['revision'])
    if action == 'save':
        write_json(task_path(root, task_id), request['value'])
        return None
    if action == 'saveSnapshot':
        if request.get('executionToken'):
            assert_owned(root, 'task-execution:' + task_id, request['executionToken'])
        revision = request['revision']
        parent = request.get('parent')
        save_git_snapshot(root, task_id, revision, request['value'], parent)
        return None
    raise ValueError('Unknown task store action')
