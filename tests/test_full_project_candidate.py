import base64
from types import SimpleNamespace
import unittest

from assets.snapshot import make_snapshot
from assets.runtime_skills import from_files
from migration.execution_ports import ExecutionPorts


class FullProjectCandidateTests(unittest.IsolatedAsyncioTestCase):
    async def freeze(self, *, preparing=False, project_runtime=False):
        files = {name: base64.b64encode(value.encode()).decode() for name, value in {
            'app/main.py': 'print("original agent")',
            'skills/book/SKILL.md': '---\nname: book\ndescription: book a room\n---\nUse real tools.',
            'skills/cancel/SKILL.md': '---\nname: cancel\ndescription: cancel a room\n---\nConfirm before writes.'}.items()}
        task = {'inputKind': 'agent_project', 'attempts': [{'id': 'attempt', 'prepareProject': preparing}],
                'configuration': {'executionMode': 'agent_project'} if project_runtime else {}, 'candidates': []}
        service = SimpleNamespace(repository=None)
        return await ExecutionPorts(service).handle('freeze', {'taskId': 'project', 'attemptId': 'attempt',
            'task': task, 'base': make_snapshot(files, 'source', project=True), 'result': {'files': files}})

    async def test_full_project_migration_discovers_all_delivery_skills(self):
        frozen = await self.freeze()
        self.assertEqual({item['skillId'] for item in frozen['revision']['members']}, {'book', 'cancel'})
        self.assertEqual(len(from_files(frozen['revision'])['skills']), 2)

    async def test_preparation_or_explicit_original_agent_stays_project_execution(self):
        for options in ({'preparing': True}, {'project_runtime': True}):
            frozen = await self.freeze(**options)
            self.assertEqual(frozen['revision']['members'], [])
