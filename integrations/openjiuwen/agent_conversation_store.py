"""Durable user-visible task conversation and pending interaction records.

Agent context remains in OpenJiuwen's checkpointer. This store contains only
the user-visible timeline and delivery state required by the task host/UI.
The caller must authorize the task and hold its execution lease.
"""

import json
from pathlib import Path

import aiosqlite


class InteractionConflict(ValueError):
    status = 409


class ConversationStore:
    def __init__(self, data_root: str | Path):
        root = Path(data_root).expanduser().resolve()
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / 'agent-conversations.db'

    async def initialize(self):
        async with aiosqlite.connect(self.path) as db:
            await db.execute('PRAGMA journal_mode=WAL')
            await db.executescript('''
                CREATE TABLE IF NOT EXISTS events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    event_key TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    payload TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
                    UNIQUE(session_id, event_key)
                );
                CREATE INDEX IF NOT EXISTS events_session_sequence ON events(session_id, sequence);
                CREATE TABLE IF NOT EXISTS interactions (
                    session_id TEXT NOT NULL,
                    interaction_id TEXT NOT NULL,
                    request TEXT NOT NULL,
                    answer TEXT,
                    status TEXT NOT NULL CHECK(status IN ('pending','answered','delivering','delivered')),
                    PRIMARY KEY(session_id, interaction_id)
                );
                CREATE TABLE IF NOT EXISTS instructions (
                    session_id TEXT NOT NULL,
                    request_id TEXT NOT NULL,
                    text TEXT NOT NULL,
                    status TEXT NOT NULL CHECK(status IN ('queued','sending','accepted','uncertain')),
                    PRIMARY KEY(session_id, request_id)
                );
                CREATE TABLE IF NOT EXISTS paused_rounds (
                    session_id TEXT NOT NULL,
                    attempt_id TEXT NOT NULL,
                    pause_id TEXT NOT NULL,
                    query TEXT,
                    status TEXT NOT NULL CHECK(status IN ('paused','resuming','resumed','cancelled')),
                    PRIMARY KEY(session_id, attempt_id)
                );
                CREATE TABLE IF NOT EXISTS recovery_rounds (
                    session_id TEXT NOT NULL,
                    attempt_id TEXT NOT NULL,
                    query TEXT NOT NULL,
                    status TEXT NOT NULL,
                    PRIMARY KEY(session_id, attempt_id)
                );
            ''')
            await db.execute('BEGIN IMMEDIATE')
            cursor = await db.execute('PRAGMA table_info(instructions)')
            if 'attempt_id' not in {row[1] for row in await cursor.fetchall()}:
                await db.execute('ALTER TABLE instructions ADD COLUMN attempt_id TEXT')
            await db.commit()

    @staticmethod
    def _json(value):
        return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)

    async def save_recovery_round(self, session_id, attempt_id, query):
        if not isinstance(query, str) or not query.strip():
            raise ValueError('Recovery query must be text')
        async with aiosqlite.connect(self.path) as db:
            await db.execute('INSERT INTO recovery_rounds VALUES(?,?,?,?) ON CONFLICT(session_id,attempt_id) '
                             'DO UPDATE SET query=excluded.query,status=excluded.status',
                             (session_id, attempt_id, query, 'running'))
            await db.commit()

    async def finish_recovery_round(self, session_id, attempt_id, status):
        if status not in ('finished', 'waiting'):
            raise ValueError('Invalid round completion')
        async with aiosqlite.connect(self.path) as db:
            await db.execute('UPDATE recovery_rounds SET status=? WHERE session_id=? AND attempt_id=?',
                             (status, session_id, attempt_id))
            await db.commit()

    async def recovery_round(self, session_id, attempt_id):
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute('SELECT query,status FROM recovery_rounds WHERE session_id=? AND attempt_id=?',
                                      (session_id, attempt_id))
            row = await cursor.fetchone()
        return {'query': row[0], 'status': row[1]} if row else None

    async def recovery_tools(self, session_id, attempt_id):
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute('SELECT payload FROM events WHERE session_id=? AND kind=? ORDER BY sequence',
                                      (session_id, 'tool_boundary'))
            records = [json.loads(row[0]) for row in await cursor.fetchall()]
        calls = {}
        for record in records:
            if record.get('attemptId') == attempt_id:
                calls[record['callId']] = record
        return list(calls.values())[-100:]

    async def append(self, session_id: str, event_key: str, kind: str, payload: dict):
        if not session_id or not event_key or not kind or not isinstance(payload, dict):
            raise ValueError('session, event key, kind and payload are required')
        encoded = self._json(payload)
        async with aiosqlite.connect(self.path) as db:
            await db.execute('BEGIN IMMEDIATE')
            await db.execute('INSERT OR IGNORE INTO events(session_id,event_key,kind,payload) VALUES(?,?,?,?)',
                             (session_id, event_key, kind, encoded))
            cursor = await db.execute('SELECT sequence,kind,payload FROM events WHERE session_id=? AND event_key=?',
                                      (session_id, event_key))
            sequence, old_kind, old_payload = await cursor.fetchone()
            if (old_kind, old_payload) != (kind, encoded):
                await db.rollback()
                raise InteractionConflict('event key already exists with different content')
            await db.commit()
            return sequence

    async def events(self, session_id: str, after: int = 0, limit: int = 100):
        if not session_id or after < 0 or not 1 <= limit <= 500:
            raise ValueError('invalid event cursor or limit')
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute('''SELECT e.sequence,e.event_key,e.kind,e.payload,e.created_at,i.status
                FROM events e LEFT JOIN instructions i
                  ON i.session_id=e.session_id AND e.event_key='instruction:' || i.request_id
                WHERE e.session_id=? AND e.sequence>? ORDER BY e.sequence LIMIT ?''', (session_id, after, limit))
            rows = await cursor.fetchall()
        return [{'sequence': row[0], 'eventKey': row[1], 'kind': row[2],
                 'payload': json.loads(row[3]), 'createdAt': row[4],
                 **({'deliveryStatus': row[5]} if row[5] else {})} for row in rows]

    async def task_goals_since(self, session_id: str, after: int):
        async with aiosqlite.connect(self.path) as db:
            try:
                cursor = await db.execute("SELECT sequence,payload,created_at FROM events WHERE session_id=? AND kind='task_goal' AND sequence>? ORDER BY sequence", (session_id, after))
                rows = await cursor.fetchall()
            except aiosqlite.OperationalError as error:
                # A concurrent first startup can create the database before its
                # schema transaction completes; there can be no saved event yet.
                if str(error) != 'no such table: events':
                    raise
                return []
        return [{'sequence': row[0], 'payload': json.loads(row[1]), 'createdAt': row[2]} for row in rows]

    async def ask(self, session_id: str, interaction_id: str, request: dict):
        if not session_id or not interaction_id or not isinstance(request, dict):
            raise ValueError('session, interaction ID and request are required')
        encoded = self._json(request)
        async with aiosqlite.connect(self.path) as db:
            await db.execute('BEGIN IMMEDIATE')
            await db.execute('INSERT OR IGNORE INTO interactions VALUES(?,?,?,NULL,?)',
                             (session_id, interaction_id, encoded, 'pending'))
            cursor = await db.execute('SELECT request,status FROM interactions WHERE session_id=? AND interaction_id=?',
                                      (session_id, interaction_id))
            previous, status = await cursor.fetchone()
            if previous != encoded:
                await db.rollback()
                raise InteractionConflict('interaction ID already exists with a different request')
            await db.execute('INSERT OR IGNORE INTO events(session_id,event_key,kind,payload) VALUES(?,?,?,?)',
                             (session_id, 'question:' + interaction_id, 'question', encoded))
            await db.commit()
            return status

    async def answer(self, session_id: str, interaction_id: str, answers: dict[str, str]):
        if not isinstance(answers, dict) or not answers or any(
            not isinstance(key, str) or not key or not isinstance(value, str) for key, value in answers.items()
        ):
            raise ValueError('answers must map question text to answer text')
        encoded = self._json(answers)
        async with aiosqlite.connect(self.path) as db:
            await db.execute('BEGIN IMMEDIATE')
            cursor = await db.execute('SELECT answer,status,request FROM interactions WHERE session_id=? AND interaction_id=?',
                                      (session_id, interaction_id))
            row = await cursor.fetchone()
            if row is None:
                await db.rollback()
                raise InteractionConflict('interaction not found')
            previous, status, stored_request = row
            request = json.loads(stored_request)
            request_value = request.get('value', request)
            questions = request_value.get('questions', []) if isinstance(request_value, dict) else []
            expected = {item.get('question') for item in questions if isinstance(item, dict)
                        and isinstance(item.get('question'), str) and item['question']}
            if expected and set(answers) != expected:
                await db.rollback()
                raise InteractionConflict('answers do not match the pending questions')
            if previous is not None and previous != encoded:
                await db.rollback()
                raise InteractionConflict('interaction was already answered differently')
            if status == 'pending':
                await db.execute('UPDATE interactions SET answer=?,status=? WHERE session_id=? AND interaction_id=?',
                                 (encoded, 'answered', session_id, interaction_id))
                await db.execute('INSERT INTO events(session_id,event_key,kind,payload) VALUES(?,?,?,?)',
                                 (session_id, 'answer:' + interaction_id, 'answer', encoded))
                status = 'answered'
            await db.commit()
            return status

    async def interactions(self, session_id: str):
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute('''SELECT interaction_id,request,answer,status FROM interactions
                WHERE session_id=? AND status != 'delivered' ORDER BY rowid''', (session_id,))
            rows = await cursor.fetchall()
        return [{'interactionId': row[0], 'request': json.loads(row[1]),
                 'answer': json.loads(row[2]) if row[2] else None, 'status': row[3]} for row in rows]

    async def delivered(self, session_id: str, interaction_id: str):
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute('''UPDATE interactions SET status='delivered'
                WHERE session_id=? AND interaction_id=? AND status='delivering' ''', (session_id, interaction_id))
            await db.commit()
            if cursor.rowcount != 1:
                raise InteractionConflict('interaction is not being delivered')

    async def begin_delivery(self, session_id: str, interaction_id: str):
        """Claim one stored answer. A crash after this point requires reconciliation."""
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute('''UPDATE interactions SET status='delivering'
                WHERE session_id=? AND interaction_id=? AND status='answered' ''', (session_id, interaction_id))
            await db.commit()
            if cursor.rowcount != 1:
                raise InteractionConflict('answer is already delivering, delivered, or unavailable')

    async def queue_instruction(self, session_id: str, request_id: str, text: str, attempt_id: str | None = None):
        if not session_id or not request_id or not isinstance(text, str) or not text.strip():
            raise ValueError('session, request ID and text are required')
        async with aiosqlite.connect(self.path) as db:
            await db.execute('BEGIN IMMEDIATE')
            await db.execute('INSERT OR IGNORE INTO instructions(session_id,request_id,text,status,attempt_id) VALUES(?,?,?,?,?)',
                             (session_id, request_id, text, 'queued', attempt_id))
            cursor = await db.execute('SELECT text,status,attempt_id FROM instructions WHERE session_id=? AND request_id=?',
                                      (session_id, request_id))
            saved, status, saved_attempt = await cursor.fetchone()
            if saved != text or saved_attempt != attempt_id:
                await db.rollback()
                raise InteractionConflict('instruction request ID was used for different text')
            await db.execute('INSERT OR IGNORE INTO events(session_id,event_key,kind,payload) VALUES(?,?,?,?)',
                             (session_id, 'instruction:' + request_id, 'message', self._json({'role': 'user', 'text': text})))
            await db.commit()
            return status

    async def queued_instructions(self, session_id: str, attempt_id: str):
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute("SELECT request_id,text FROM instructions WHERE session_id=? AND attempt_id=? AND status='queued' ORDER BY rowid", (session_id, attempt_id))
            return [{'key': row[0], 'text': row[1]} for row in await cursor.fetchall()]

    async def save_paused_round(self, session_id: str, attempt_id: str, pause_id: str, query: str | None):
        if not session_id or not attempt_id or not pause_id or (query is not None and not isinstance(query, str)):
            raise ValueError('Invalid paused round')
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute('''INSERT INTO paused_rounds(session_id,attempt_id,pause_id,query,status)
                VALUES(?,?,?,?, 'paused') ON CONFLICT(session_id,attempt_id) DO UPDATE SET
                pause_id=excluded.pause_id,query=excluded.query,status='paused'
                WHERE paused_rounds.status IN ('resumed','cancelled')''', (session_id, attempt_id, pause_id, query))
            await db.commit()
            if cursor.rowcount != 1:
                raise InteractionConflict('An unresolved paused round already exists')

    async def paused_round(self, session_id: str, attempt_id: str):
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute('SELECT pause_id,query,status FROM paused_rounds WHERE session_id=? AND attempt_id=?',
                                      (session_id, attempt_id))
            row = await cursor.fetchone()
        return {'pauseId':row[0], 'query':row[1], 'status':row[2]} if row else None

    async def transition_paused_round(self, session_id: str, attempt_id: str, pause_id: str, before: str, after: str):
        if (before, after) not in {('paused','resuming'),('resuming','resumed'),('paused','cancelled')}:
            raise ValueError('Invalid paused round transition')
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute('UPDATE paused_rounds SET status=? WHERE session_id=? AND attempt_id=? AND pause_id=? AND status=?',
                                      (after, session_id, attempt_id, pause_id, before))
            await db.commit()
            if cursor.rowcount != 1:
                raise InteractionConflict('Paused round state changed')

    async def get_instruction(self, session_id: str, request_id: str, text: str):
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute('SELECT text,status FROM instructions WHERE session_id=? AND request_id=?',
                                      (session_id, request_id))
            row = await cursor.fetchone()
        if row is None:
            return None
        if row[0] != text:
            raise InteractionConflict('instruction request ID was used for different text')
        return row[1]

    async def instruction_status(self, session_id: str, request_id: str, before: str, after: str):
        transitions = {('queued', 'sending'), ('sending', 'accepted'), ('sending', 'uncertain')}
        if (before, after) not in transitions:
            raise ValueError('invalid instruction state transition')
        async with aiosqlite.connect(self.path) as db:
            cursor = await db.execute('''UPDATE instructions SET status=?
                WHERE session_id=? AND request_id=? AND status=?''', (after, session_id, request_id, before))
            await db.commit()
            if cursor.rowcount != 1:
                raise InteractionConflict('instruction state has changed')
