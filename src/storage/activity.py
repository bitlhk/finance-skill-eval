"""Durable progress projection; the full Agent conversation remains separate."""
import asyncio
from pathlib import Path
from .tasks import read_json, write_json, TASK_ID
from .coordination import execute as coordinate
from tasks.values import now


class ActivityStore:
    def __init__(self, root):
        self.root = Path(root)

    def path(self, identifier):
        if not TASK_ID.fullmatch(identifier):
            raise ValueError('Invalid task ID')
        return self.root / 'migration-activity' / (identifier + '.json')

    async def get(self, identifier):
        def read():
            try:
                value = read_json(self.path(identifier))
            except FileNotFoundError:
                return None
            if value['status'] == 'RUNNING' and not coordinate({'root': str(self.root), 'action': 'busy', 'key': 'task-execution:' + identifier}):
                value['status'] = 'INTERRUPTED'
            return value
        return await asyncio.to_thread(read)

    async def start(self, identifier, attempt_id):
        value = {'taskId': attempt_id, 'status': 'RUNNING', 'startedAt': now(), 'updatedAt': now(), 'events': []}
        await asyncio.to_thread(write_json, self.path(identifier), value)
        return value

    async def emit(self, identifier, kind, label, text=None, *, status=None):
        def update():
            from filelock import FileLock
            from .coordination import lock_path
            with FileLock(str(lock_path(self.root, 'task-activity:' + identifier)), timeout=15):
                try:
                    value = read_json(self.path(identifier))
                except FileNotFoundError:
                    return
                value['updatedAt'] = now()
                if status:
                    value['status'] = status
                events = value['events']
                if kind == 'text_snapshot' and events and events[-1]['kind'] == kind:
                    events[-1]['text'] = (text or '')[-12000:]
                else:
                    events.append({'id': events[-1]['id'] + 1 if events else 1, 'at': value['updatedAt'],
                        'kind': kind, 'label': label[:180], **({'text': text[-12000:]} if text else {})})
                value['events'] = events[-200:]
                write_json(self.path(identifier), value)
        await asyncio.to_thread(update)
