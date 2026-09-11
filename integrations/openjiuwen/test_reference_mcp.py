import unittest
import asyncio
from integrations.openjiuwen.reference_mcp import prepare_wealth_allocation_context
from integrations.openjiuwen.reference_mcp import mcp, get_customer_profile
from integrations.openjiuwen.role_fixtures import DATA


class ReferenceSnapshotTest(unittest.TestCase):
    def query(self, **kwargs):
        return getattr(prepare_wealth_allocation_context, "fn", prepare_wealth_allocation_context)(**kwargs)

    def test_verified_fixture(self):
        result = self.query(customer_id="C005")
        self.assertEqual(result["readiness"], "READY")
        self.assertEqual(result["liquidityFloor"], 150000)

    def test_changed_constraints_are_not_silently_ignored(self):
        for change in [{"investable_amount": 1000000}, {"liquidity_ratio": 0.5}, {"investment_horizon_years": 1}]:
            with self.subTest(change=change):
                result = self.query(customer_id="C005", **change)
                self.assertEqual(result["readiness"], "DEGRADED")
                self.assertEqual(result["eligibleProducts"], [])

    def test_unconfirmed_cash_need_is_not_recommendation_ready(self):
        self.assertEqual(self.query(customer_id="C006")["readiness"], "DEGRADED")

    def test_curated_tools_are_registered_and_read_only(self):
        tools = asyncio.run(mcp.get_tools())
        self.assertEqual(len(tools), 16)
        for name, definition in DATA['tools'].items():
            tool = tools[name]
            result = tool.fn(reference=definition['defaultRef'])
            self.assertTrue(result['synthetic'])
            self.assertEqual(result['snapshotVersion'], 'roles-demo-v1')
            with self.assertRaises(ValueError):
                tool.fn(reference='unknown-real-customer')

    def test_insurance_customer_is_not_a_wealth_customer(self):
        result = getattr(get_customer_profile,'fn',get_customer_profile)(customer_id='I001')
        self.assertIn('profile',result)
        self.assertEqual(result['snapshotVersion'], 'roles-demo-v1')

    def test_unknown_risk_never_returns_no_hit(self):
        tools=asyncio.run(mcp.get_tools())
        self.assertEqual(tools['fraud_transfer_risk_assess'].fn(reference='bene-unknown')['decision'],'UNKNOWN')
