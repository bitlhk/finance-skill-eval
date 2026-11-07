"""Shared atomic JSON persistence for task, asset and evaluation records."""
from pathlib import Path

from storage.tasks import filesystem_path, read_json, write_json


def execute(request):
    path = filesystem_path(request['path'])
    if not path.is_absolute():
        raise ValueError('Storage path must be absolute')
    action = request['action']
    if action == 'ensure':
        path.mkdir(parents=True, exist_ok=True)
        return None
    if action == 'read':
        return read_json(path)
    if action == 'write':
        owner = request.get('executionOwner')
        if owner is not None:
            from storage.coordination import assert_owned
            assert_owned(owner['root'], 'task-execution:' + owner['id'], owner['token'])
        write_json(path, request['value'])
        return None
    if action == 'list':
        try:
            return [item.name for item in path.iterdir() if item.name.endswith('.json')]
        except FileNotFoundError:
            return []
    raise ValueError('Unknown JSON store action')
