"""Durable transport receipts, separate from OpenJiuwen conversation checkpoints."""
from contextlib import contextmanager, closing
import hashlib
import json
from pathlib import Path
import sqlite3
import time

from filelock import FileLock, Timeout


class ExecutionJournal:
    def __init__(self, root, max_bytes):
        self.root = Path(root)
        self.max_bytes = max_bytes

    @contextmanager
    def _db(self):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        with closing(sqlite3.connect(self.root / 'executions.db', timeout=10)) as db, db:
            db.execute('CREATE TABLE IF NOT EXISTS executions (session TEXT, execution TEXT, digest TEXT, '
                       'state TEXT, finished REAL, PRIMARY KEY(session,execution))')
            db.execute('CREATE TABLE IF NOT EXISTS records (session TEXT, execution TEXT, sequence INTEGER, '
                       'payload TEXT, bytes INTEGER, PRIMARY KEY(session,execution,sequence))')
            yield db

    def _lock(self, session, execution):
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        key = hashlib.sha256(json.dumps([session, execution]).encode()).hexdigest()
        return FileLock(str(self.root / (key + '.lock')), timeout=0)

    def _row(self, db, session, execution):
        return db.execute('SELECT digest,state FROM executions WHERE session=? AND execution=?',
                          (session, execution)).fetchone()

    def start(self, session, execution, digest):
        """Claim a new execution, or replay an existing one. Never replay work."""
        lock = self._lock(session, execution)
        try:
            lock.acquire()
        except Timeout:
            with self._db() as db:
                row = self._row(db, session, execution)
                if not row or row[0] != digest:
                    raise ValueError('Execution identity conflict')
            return None
        try:
            with self._db() as db:
                db.execute('BEGIN IMMEDIATE')
                row = self._row(db, session, execution)
                if row:
                    if row[0] != digest:
                        raise ValueError('Execution identity is already associated with another request')
                    if row[1] == 'running':
                        db.execute('UPDATE executions SET state=?,finished=? WHERE session=? AND execution=?',
                                   ('interrupted', time.time(), session, execution))
                else:
                    db.execute('INSERT INTO executions VALUES(?,?,?,?,NULL)', (session, execution, digest, 'running'))
                    return lock
        except BaseException:
            lock.release()
            raise
        lock.release()
        return None

    def state(self, session, execution):
        with self._db() as db:
            row = self._row(db, session, execution)
        if not row:
            return 'missing'
        if row[1] != 'running':
            return row[1]
        lock = self._lock(session, execution)
        try:
            lock.acquire()
        except Timeout:
            return 'running'
        try:
            with self._db() as db:
                db.execute('UPDATE executions SET state=?,finished=? WHERE session=? AND execution=? AND state=?',
                           ('interrupted', time.time(), session, execution, 'running'))
                return self._row(db, session, execution)[1]
        finally:
            lock.release()

    def append(self, session, execution, record):
        encoded = json.dumps(record, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
        size = len(encoded.encode())
        with self._db() as db:
            db.execute('BEGIN IMMEDIATE')
            if self._row(db, session, execution)[1] != 'running':
                raise RuntimeError('Execution ownership is no longer valid')
            total = db.execute('SELECT coalesce(sum(bytes),0) FROM records').fetchone()[0]
            if total + size > self.max_bytes:
                raise BufferError('Execution journal capacity exceeded')
            sequence = db.execute('SELECT coalesce(max(sequence),0)+1 FROM records WHERE session=? AND execution=?',
                                  (session, execution)).fetchone()[0]
            db.execute('INSERT INTO records VALUES(?,?,?,?,?)', (session, execution, sequence, encoded, size))
            if 'result' in record or record.get('type') == 'result':
                # Publish the terminal receipt and its completion atomically.
                # A kill between yielding the result and producer cleanup must
                # not turn an already committed result into interrupted work.
                db.execute('UPDATE executions SET state=?,finished=? WHERE session=? AND execution=?',
                           ('completed', time.time(), session, execution))

    def finish(self, session, execution, error):
        with self._db() as db:
            db.execute('UPDATE executions SET state=?,finished=? WHERE session=? AND execution=? AND state=?',
                       ('failed' if error else 'completed', time.time(), session, execution, 'running'))

    def records(self, session, execution, after):
        with self._db() as db:
            return [{'sequence': row[0], 'record': json.loads(row[1])} for row in db.execute(
                'SELECT sequence,payload FROM records WHERE session=? AND execution=? AND sequence>? ORDER BY sequence',
                (session, execution, after)).fetchall()]

    def prune(self, retention_seconds, max_finished):
        with self._db() as db:
            db.execute('BEGIN IMMEDIATE')
            rows = db.execute('SELECT session,execution,finished FROM executions WHERE state!=? ORDER BY finished DESC',
                              ('running',)).fetchall()
            for index, (session, execution, finished) in enumerate(rows):
                if index >= max_finished or (finished is not None and time.time() - finished >= retention_seconds):
                    db.execute('DELETE FROM records WHERE session=? AND execution=?', (session, execution))
                    db.execute('DELETE FROM executions WHERE session=? AND execution=?', (session, execution))
