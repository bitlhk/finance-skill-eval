"""Persisted public-demo admission limits under the existing ingress identity."""
import asyncio
import hashlib
from pathlib import Path
import re
from filelock import FileLock
from storage.tasks import read_json, write_json
from storage.coordination import lock_path
from tasks.values import now
from api.identity import AccessError


class DemoAccess:
    def __init__(self, root):
        self.root = Path(root)
        self.file = self.root / 'demo-admissions.json'

    @staticmethod
    def identity(subject):
        if not isinstance(subject, str) or not re.fullmatch('studio_[a-zA-Z0-9_-]{1,80}', subject):
            raise AccessError('AUTHENTICATED_ACCOUNT_REQUIRED', 401)
        return hashlib.sha256(subject.encode()).hexdigest()

    def records(self):
        try:
            return read_json(self.file)
        except FileNotFoundError:
            return []

    async def create(self, subject, service, configuration):
        user = self.identity(subject)
        lock = FileLock(str(lock_path(self.root, 'demo-admissions')), timeout=15, thread_local=False)
        await asyncio.to_thread(lock.acquire)
        try:
            records = await asyncio.to_thread(self.records)
            timestamp = now()
            today = [record for record in records if record['at'].startswith(timestamp[:10])]
            if len(today) >= 12 or sum(record['user'] == user for record in today) >= 3:
                raise AccessError('DEMO_DAILY_QUOTA', 429, retryAfterSeconds=3600)
            if sum(job['status'] in ('queued', 'preparing', 'running', 'judging') for job in await service.list(100)) >= 3:
                raise AccessError('DEMO_BUSY', 429, retryAfterSeconds=30)
            admission = {'user': user, 'at': timestamp, 'jobId': None}
            records.append(admission)
            await asyncio.to_thread(write_json, self.file, records)
            job = await service.create(configuration)
            admission['jobId'] = job['jobId']
            await asyncio.to_thread(write_json, self.file, records)
            return job
        finally:
            await asyncio.to_thread(lock.release)

    async def assert_owner(self, subject, identifier):
        user = self.identity(subject)
        records = await asyncio.to_thread(self.records)
        if not any(record['user'] == user and record['jobId'] == identifier for record in records):
            raise AccessError('DEMO_RUN_OWNER_REQUIRED')
