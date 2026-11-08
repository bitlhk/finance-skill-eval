import unittest

from .optimization_budget_tool import build_budget_continuation_tool, latest_budget_request


class BudgetContinuationTests(unittest.IsolatedAsyncioTestCase):
    async def test_records_only_valid_request_and_recovers_it_by_attempt(self):
        class Store:
            def __init__(self): self.items = []
            async def append(self, session, key, kind, payload):
                self.items.append({'sequence':len(self.items)+1,'kind':kind,'payload':payload})
                return len(self.items)
            async def events(self, session, after=0, limit=500):
                return [item for item in self.items if item['sequence']>after][:limit]
        store=Store()
        tool=build_budget_continuation_tool(store,'session','attempt-a','owner-a')
        self.assertFalse((await tool.invoke({}))['accepted'])
        self.assertFalse((await tool.invoke({'additional_rounds':0}))['accepted'])
        self.assertFalse((await tool.invoke({'additional_seconds':30}))['accepted'])
        self.assertFalse((await tool.invoke({'additional_rounds':True}))['accepted'])
        self.assertEqual(store.items,[])
        self.assertTrue((await tool.invoke({'additional_rounds':2,'additional_seconds':120}))['accepted'])
        other=build_budget_continuation_tool(store,'session','attempt-b','owner-b')
        await other.invoke({'additional_rounds':1})
        self.assertEqual(await latest_budget_request(store,'session','attempt-a'),{
            'attemptId':'attempt-a','ownerAttemptId':'owner-a','additionalRounds':2,'additionalSeconds':120})
        self.assertIsNone(await latest_budget_request(store,'session','missing'))
        self.assertFalse((await tool.invoke({'cancel':True,'additional_rounds':1}))['accepted'])
        self.assertTrue((await tool.invoke({'cancel':True}))['accepted'])
        self.assertIsNone(await latest_budget_request(store,'session','attempt-a'))
        self.assertEqual((await latest_budget_request(store,'session','attempt-b'))['additionalRounds'],1)
        self.assertTrue((await tool.invoke({'additional_rounds':3}))['accepted'])
        self.assertEqual((await latest_budget_request(store,'session','attempt-a'))['additionalRounds'],3)
