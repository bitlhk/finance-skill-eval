"""Native asynchronous task repository over the existing CAS/Git storage.

Execution ownership follows the coroutine context, including background work.
File locks and revision checks protect the same data across API replicas.
"""
import asyncio
from contextlib import asynccontextmanager
from contextvars import ContextVar
import inspect
from pathlib import Path
import time

from .tasks import execute as tasks
from .conversations import execute as conversations
from .coordination import execute as coordinate, CoordinationConflict


execution_owner = ContextVar('task_execution_owner', default=None)


class TaskRepository:
    def __init__(self, root):
        self.root = str(Path(root).absolute())

    async def call(self, action, **fields):
        owner = execution_owner.get()
        if owner and owner['root'] == self.root and owner['id'] == fields.get('id'):
            fields['executionToken'] = owner['token']
        return await asyncio.to_thread(tasks, {'root': self.root, 'action': action, **fields})

    async def conversation(self, identifier, action='get', **fields):
        return await asyncio.to_thread(conversations, {'root': self.root, 'id': identifier, 'action': action, **fields})

    async def list(self):
        return await self.call('list')

    async def get(self, identifier):
        return await self.call('get', id=identifier)

    async def read_snapshot(self, identifier, revision=None):
        return await self.call('readSnapshot', id=identifier, revision=revision or 'source')

    async def save_snapshot(self, identifier, revision, value, parent=None):
        return await self.call('saveSnapshot', id=identifier, revision=revision, value=value, parent=parent)

    async def acquire(self, key, wait_ms=0):
        expires = time.monotonic() + wait_ms / 1000
        while True:
            token = await asyncio.to_thread(coordinate, {'root': self.root, 'key': key, 'action': 'acquire'})
            if token or time.monotonic() >= expires:
                return token
            await asyncio.sleep(0.05)

    async def release(self, key, token):
        await asyncio.to_thread(coordinate, {'root': self.root, 'key': key, 'action': 'release', 'token': token})

    @asynccontextmanager
    async def ownership(self, identifier, *, wait_ms=0):
        inherited = execution_owner.get()
        if inherited and inherited['root'] == self.root and inherited['id'] == identifier:
            yield inherited
            return
        key = 'task-execution:' + identifier
        token = await self.acquire(key, wait_ms)
        if not token:
            raise CoordinationConflict('该任务正在由其他请求处理')
        scope = execution_owner.set({'root': self.root, 'id': identifier, 'token': token})
        try:
            yield execution_owner.get()
        finally:
            execution_owner.reset(scope)
            await self.release(key, token)

    async def update(self, identifier, change, *, create=False):
        key = 'task-write:' + identifier
        token = await self.acquire(key, 15000)
        if not token:
            raise CoordinationConflict('任务正在保存，请稍后重试')
        try:
            try:
                versioned = await self.call('getVersioned', id=identifier)
                task, revision = versioned['task'], versioned['revision']
            except FileNotFoundError:
                if not create:
                    raise
                task, revision = {}, None
            result = change(task)
            if inspect.isawaitable(result):
                await result
            await self.call('saveVersioned', id=identifier, writeToken=token, expectedRevision=revision, value=task)
            return task
        finally:
            await self.release(key, token)

    async def save(self, task):
        def replace(current):
            current.clear()
            current.update(task)
        return await self.update(task['id'], replace, create=True)
