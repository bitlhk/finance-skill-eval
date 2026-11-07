import tempfile
import unittest
from pathlib import Path

from .agent_conversation_store import ConversationStore
from .migration_delivery_tools import build_delivery_tools_tool, build_delivery_tools_query, latest_delivery_tools, validate_delivery_tools


class DeliveryToolsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.candidate = self.root / 'candidate'
        self.candidate.mkdir()
        (self.candidate / 'server.py').write_text('print("fixture")', encoding='utf-8')
        self.store = ConversationStore(self.root / 'data')
        await self.store.initialize()
        self.value = {'services': [{'toolNames': ['query'], 'filePaths': ['server.py'], 'start': ['python', 'server.py']}],
                      'tools': [{'toolId': 'query', 'form': 'MCP', 'entrypoint': 'query', 'files': ['server.py'],
                                 'invocation': 'MCP query', 'configuration': 'existing runtime identity'}]}

    async def test_registration_survives_store_recreation_and_is_scoped_to_attempt(self):
        tool = build_delivery_tools_tool(self.store, 'session', 'attempt', self.candidate)
        self.assertTrue((await tool.invoke(self.value))['accepted'])
        reopened = ConversationStore(self.root / 'data')
        self.assertEqual(await latest_delivery_tools(reopened, 'session', 'attempt', self.candidate), self.value)
        self.assertIsNone(await latest_delivery_tools(reopened, 'other-session', 'attempt', self.candidate))
        self.assertIsNone(await latest_delivery_tools(reopened, 'session', 'other-attempt', self.candidate))
        current = await build_delivery_tools_query(reopened, 'session', 'attempt', self.candidate).invoke({})
        self.assertTrue(current['registered'])
        self.assertEqual(current['source'], 'CURRENT_ATTEMPT')
        missing = await build_delivery_tools_query(reopened, 'session', 'other-attempt', self.candidate).invoke({})
        self.assertFalse(missing['registered'])
        published = await build_delivery_tools_query(reopened, 'session', 'other-attempt', self.candidate, self.value).invoke({})
        self.assertEqual(published['source'], 'PUBLISHED_CANDIDATE')

    async def test_revalidates_files_after_agent_edits(self):
        tool = build_delivery_tools_tool(self.store, 'session', 'attempt', self.candidate)
        await tool.invoke(self.value)
        (self.candidate / 'server.py').unlink()
        with self.assertRaisesRegex(ValueError, '文件不存在'):
            await latest_delivery_tools(self.store, 'session', 'attempt', self.candidate)

    async def test_rejects_path_escape_and_missing_service_without_recording(self):
        import copy
        for fault in ('path', 'service', 'duplicate', 'entrypoint'):
            value = copy.deepcopy(self.value)
            if fault == 'path':
                value['services'][0]['filePaths'] = ['../outside.py']
            elif fault == 'service':
                value['services'] = []
            elif fault == 'entrypoint':
                value['tools'][0]['entrypoint'] = 'server.py'
            else:
                value['tools'].append(value['tools'][0].copy())
            tool = build_delivery_tools_tool(self.store, 'session', 'attempt', self.candidate)
            result = await tool.invoke(value)
            self.assertFalse(result['accepted'])
            if fault == 'entrypoint':
                self.assertIn('entrypoint=server.py', result['reason'])
                self.assertIn('query', result['reason'])
        self.assertIsNone(await latest_delivery_tools(self.store, 'session', 'attempt', self.candidate))

    async def test_supports_cli_script_and_removing_all_tools(self):
        value = {'services': [], 'tools': [{**self.value['tools'][0], 'form': 'CLI', 'entrypoint': 'expense check --json'}]}
        self.assertEqual(validate_delivery_tools(value, self.candidate), value)
        tool = build_delivery_tools_tool(self.store, 'session', 'attempt', self.candidate)
        self.assertTrue((await tool.invoke(value))['accepted'])
        self.assertTrue((await tool.invoke({'services': [], 'tools': []}))['accepted'])
        self.assertEqual(await latest_delivery_tools(self.store, 'session', 'attempt', self.candidate), {'services': [], 'tools': []})
