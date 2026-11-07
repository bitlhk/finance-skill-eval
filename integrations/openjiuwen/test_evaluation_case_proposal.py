import unittest

from .evaluation_case_proposal import build_case_proposal_tool


class ProposalTests(unittest.IsolatedAsyncioTestCase):
    async def test_proposal_records_only_development_suggestions_without_mutation(self):
        class Store:
            def __init__(self): self.events = []
            async def append(self, session, key, kind, payload):
                self.events.append((session, key, kind, payload))
                return 7
        store = Store()
        tool = build_case_proposal_tool(store, 'session', 'attempt', lambda text: text.replace('SECRET', '[redacted]'))
        result = await tool.invoke({'name':'会议室测试','coverage':'覆盖只读场景；状态待确认',
            'cases':[{'input':'查询 SECRET 的权限','criteria':['结果与实际授权一致'],'rationale':'正常路径',
                      'repeatSafety':'read_only','stateFixture':{'fixtureId':'invented'}}]})
        self.assertTrue(result['accepted'])
        payload = store.events[0][3]
        self.assertEqual(store.events[0][2], 'case_proposal')
        self.assertEqual(payload['cases'],[{'input':'查询 [redacted] 的权限','criteria':['结果与实际授权一致'],'rationale':'正常路径'}])
        self.assertNotIn('holdoutCases', payload)

    async def test_invalid_proposal_is_not_published(self):
        class Store:
            async def append(self, *_): raise AssertionError('invalid proposals must not be saved')
        tool = build_case_proposal_tool(Store(), 'session', 'attempt', lambda value: value)
        result = await tool.invoke({'name':'test','coverage':'unknown','cases':[{'input':'查询','criteria':['']}]})
        self.assertFalse(result['accepted'])
