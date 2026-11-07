import asyncio
from pathlib import Path
import tempfile
import unittest
import shutil

from storage.tasks import SCHEMA, write_json, task_path
from storage.conversations import execute
from integrations.openjiuwen.agent_conversation_store import ConversationStore
from integrations.openjiuwen.session_identity import persistent_workspace_scope, task_session_identity


class TaskConversationTests(unittest.TestCase):
    def test_workspace_scope_survives_data_mount_path_change(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            scope = persistent_workspace_scope(first)
            self.assertNotEqual(scope, persistent_workspace_scope(second))
            shutil.copyfile(Path(first) / 'workspace-scope', Path(second) / 'workspace-scope')
            self.assertEqual(persistent_workspace_scope(second), scope)
            self.assertEqual(task_session_identity(scope, 'bundle-1111'),
                             task_session_identity(persistent_workspace_scope(second), 'bundle-1111'))

    def test_existing_task_reads_its_own_persisted_conversation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            task_id = 'bundle-1111'
            other_id = 'bundle-2222'
            for identity in (task_id, other_id):
                write_json(task_path(root, identity), {'schemaVersion': SCHEMA, 'id': identity})
            request = {'root': str(root), 'action': 'get', 'id': task_id}
            self.assertEqual(execute(request)['status'], 'not_started')

            async def prepare():
                store = ConversationStore(root / 'migration-agent')
                await store.initialize()
                session_id = task_session_identity(persistent_workspace_scope(root / 'migration-agent'), task_id)
                await store.ask(session_id, 'call-1', {'value': {'question': '请选择'}})
                await store.answer(session_id, 'call-1', {'请选择': 'A'})
            asyncio.run(prepare())
            result = execute(request)
            self.assertEqual(result['status'], 'available')
            self.assertEqual([event['kind'] for event in result['events']], ['question', 'answer'])
            self.assertEqual(result['interactions'][0]['status'], 'answered')
            self.assertEqual(execute({**request, 'id': other_id})['events'], [])
            self.assertEqual(len(execute({**request, 'after': result['events'][0]['sequence']})['events']), 1)
            with self.assertRaises(FileNotFoundError):
                execute({**request, 'id': 'bundle-3333'})
            with self.assertRaises(ValueError):
                execute({**request, 'id': '../other'})
