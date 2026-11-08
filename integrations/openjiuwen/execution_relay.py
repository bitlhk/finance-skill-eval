"""Keep a live Runtime execution independent of an HTTP subscriber.

This is a transport buffer, not a replacement for the SDK checkpoint or the
platform task store. Durable receipts survive loss of the Runtime process;
interrupted work is reconciled with the SDK checkpoint, never auto-replayed.
"""
import asyncio
import hashlib
import json
import time
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable


@dataclass
class _Execution:
    digest: str
    records: list[dict[str, Any]] = field(default_factory=list)
    condition: asyncio.Condition = field(default_factory=asyncio.Condition)
    done: bool = False
    error: bool = False
    finished_at: float | None = None
    size_bytes: int = 0
    task: asyncio.Task | None = None


class ExecutionRelay:
    """One producer per request identity; subscribers may disconnect or reattach."""
    def __init__(self, *, retention_seconds=1800, max_finished=128, max_bytes=512*1024*1024, journal_root=None):
        if retention_seconds < 0 or max_finished < 0 or max_bytes < 1:
            raise ValueError('Invalid execution relay limits')
        self.retention_seconds = retention_seconds
        self.max_finished = max_finished
        self.max_bytes = max_bytes
        self._bytes = 0
        self._executions: dict[tuple[str, str], _Execution] = {}
        if journal_root is not None:
            from .execution_journal import ExecutionJournal
            self.journal = ExecutionJournal(journal_root, max_bytes)
        else:
            self.journal = None

    def _remove(self, key):
        job = self._executions.pop(key, None)
        if job is not None:
            self._bytes -= job.size_bytes

    def _reserve(self, size):
        if self._bytes + size <= self.max_bytes:
            return
        finished = sorted(((key, job) for key, job in self._executions.items() if job.done),
                          key=lambda item: item[1].finished_at or 0)
        for key, _ in finished:
            self._remove(key)
            if self._bytes + size <= self.max_bytes:
                return
        raise BufferError('Execution output exceeds relay capacity')

    def _prune(self):
        now = time.monotonic()
        finished = sorted(((key, job) for key, job in self._executions.items() if job.done),
                          key=lambda item: item[1].finished_at or 0)
        for index, (key, job) in enumerate(finished):
            if now - (job.finished_at or now) >= self.retention_seconds or index < len(finished) - self.max_finished:
                self._remove(key)

    def has(self, session_id: str, request_id: str) -> bool:
        self._prune()
        if self.journal:
            return self.journal.state(session_id, request_id) != 'missing'
        return (session_id, request_id) in self._executions

    def state(self, session_id, request_id):
        if self.journal:
            return self.journal.state(session_id, request_id)
        job = self._executions.get((session_id, request_id))
        return 'missing' if job is None else 'running' if not job.done else 'failed' if job.error else 'completed'

    def start(self, session_id: str, request_id: str, payload: dict,
              producer: Callable[[], AsyncIterator[dict]]) -> None:
        if not session_id or not request_id or not isinstance(payload, dict):
            raise ValueError('Execution identity and payload are required')
        self._prune()
        encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        digest = hashlib.sha256(encoded.encode('utf-8')).hexdigest()
        key = (session_id, request_id)
        existing = self._executions.get(key)
        if existing:
            if existing.digest != digest:
                raise ValueError('Execution identity is already associated with another request')
            return
        lease = None
        if self.journal:
            self.journal.prune(self.retention_seconds, self.max_finished)
            lease = self.journal.start(session_id, request_id, digest)
            if lease is None:
                return
        job = _Execution(digest=digest)
        self._executions[key] = job

        async def run():
            final_result = False
            try:
                async for record in producer():
                    if not isinstance(record, dict):
                        raise ValueError('Invalid execution event')
                    size = len(json.dumps(record, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8'))
                    async with job.condition:
                        self._reserve(size)
                        if self.journal:
                            self.journal.append(session_id, request_id, record)
                        job.records.append(record)
                        job.size_bytes += size
                        self._bytes += size
                        final_result = final_result or 'result' in record or record.get('type') == 'result'
                        job.condition.notify_all()
            except asyncio.CancelledError:
                job.error = True
                raise
            except Exception:
                job.error = True
            finally:
                if self.journal:
                    try:
                        job.error = job.error or not final_result
                        self.journal.finish(session_id, request_id, job.error)
                    finally:
                        lease.release()
                async with job.condition:
                    job.done = True
                    job.finished_at = time.monotonic()
                    job.condition.notify_all()
                self._prune()
        job.task = asyncio.create_task(run())

    async def subscribe(self, session_id: str, request_id: str, after: int = 0):
        if not isinstance(after, int) or isinstance(after, bool) or after < 0:
            raise ValueError('Invalid event cursor')
        if self.journal:
            cursor = after
            while True:
                state = self.journal.state(session_id, request_id)
                if state == 'missing':
                    raise KeyError('Execution is not available')
                pending = self.journal.records(session_id, request_id, cursor)
                for item in pending:
                    cursor = item['sequence']
                    yield item
                if state != 'running':
                    if state != 'completed':
                        raise RuntimeError('Runtime execution ended without a confirmed result')
                    break
                await asyncio.sleep(0.05)
            return
        job = self._executions.get((session_id, request_id))
        if job is None:
            raise KeyError('Execution is not available')
        cursor = after
        while True:
            async with job.condition:
                await job.condition.wait_for(lambda: len(job.records) > cursor or job.done)
                pending = job.records[cursor:]
                terminal = job.done
                error = job.error
            for record in pending:
                cursor += 1
                yield {'sequence': cursor, 'record': record}
            if terminal:
                if error:
                    raise RuntimeError('Runtime execution ended without a confirmed result')
                break

    async def close(self):
        tasks = [job.task for job in self._executions.values() if job.task and not job.task.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
