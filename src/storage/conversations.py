"""Expose the platform Agent's conversation through the existing task store."""
import asyncio
from pathlib import Path
import sys

from storage.tasks import filesystem_path, get_task

# The store bridge runs this file as a script, not as a project package.
_project_root = str(Path(__file__).resolve().parents[2])
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

from integrations.openjiuwen.agent_conversation_store import ConversationStore
from integrations.openjiuwen.session_identity import persistent_workspace_scope, task_session_identity


async def _read(root, task_id, after, limit):
    # The HTTP service enforces workspace authorization; validate task existence here.
    get_task(root, task_id)
    data_root = root / 'migration-agent'
    session_id = task_session_identity(persistent_workspace_scope(data_root), task_id)
    if not (data_root / 'agent-conversations.db').is_file():
        return {'sessionId': session_id, 'status': 'not_started', 'events': [], 'interactions': []}
    store = ConversationStore(data_root)
    await store.initialize()
    events = await store.events(session_id, after=after, limit=limit)
    interactions = await store.interactions(session_id)
    exists = bool(events or interactions or (after and await store.events(session_id, limit=1)))
    return {'sessionId': session_id, 'status': 'available' if exists else 'not_started',
            'events': events, 'interactions': interactions}


async def _instruction(root, request):
    task_id = request['id']
    get_task(root, task_id)
    data_root = root / 'migration-agent'
    if request['action'] in ('taskGoalsSince','pausedRound','recoveryRound') and not (data_root / 'agent-conversations.db').is_file():
        return [] if request['action']=='taskGoalsSince' else None
    session_id = task_session_identity(persistent_workspace_scope(data_root), task_id)
    store = ConversationStore(data_root)
    if request['action'] == 'recoveryRound':
        await store.initialize()
        record = await store.recovery_round(session_id, request['attemptId'])
        return None if record is None else {'status':record['status'], 'recoverable':bool(record['query'])}
    if request['action'] == 'taskGoalsSince':
        after = request.get('after', 0)
        if not isinstance(after, int) or isinstance(after, bool) or after < 0:
            raise ValueError('Invalid task goal cursor')
        return await store.task_goals_since(session_id, after)
    if request['action'] == 'pausedRound':
        record = await store.paused_round(session_id, request['attemptId'])
        return None if record is None else {'pauseId':record['pauseId'], 'status':record['status'], 'recoverable':bool(record['query'])}
    await store.initialize()
    action = request['action']
    if action == 'getInstruction':
        return await store.get_instruction(session_id, request['key'], request['text'])
    if action == 'queueInstruction':
        return await store.queue_instruction(session_id, request['key'], request['text'], request.get('attemptId'))
    if action == 'queuedInstructions':
        return await store.queued_instructions(session_id, request['attemptId'])
    if action == 'cancelPausedRound':
        record = await store.paused_round(session_id, request['attemptId'])
        if not record or record['status'] != 'paused':
            raise ValueError('Paused round is not safely cancellable')
        await store.transition_paused_round(session_id, request['attemptId'], record['pauseId'], 'paused', 'cancelled')
        return None
    if action == 'instructionStatus':
        await store.instruction_status(session_id, request['key'], request['before'], request['after'])
        return None
    raise ValueError('Unknown conversation action')


def execute(request):
    root = filesystem_path(request['root'])
    if not root.is_absolute():
        raise ValueError('Storage root must be absolute')
    if request.get('action') in ('getInstruction', 'queueInstruction', 'queuedInstructions', 'instructionStatus', 'taskGoalsSince', 'pausedRound', 'cancelPausedRound', 'recoveryRound'):
        return asyncio.run(_instruction(root, request))
    if request.get('action') != 'get':
        raise ValueError('Unknown conversation action')
    after, limit = request.get('after', 0), request.get('limit', 100)
    if (not isinstance(after, int) or isinstance(after, bool) or after < 0
            or not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 500):
        raise ValueError('Invalid conversation cursor')
    return asyncio.run(_read(root, request['id'], after, limit))
