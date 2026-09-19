import importlib.util
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest


ROOT = Path(__file__).parent


class FakeFastMCP:
    """Minimal decorator stub: fixture data tests must not need the MCP runtime."""

    def __init__(self, _name: str):
        pass

    def tool(self, **_options):
        return lambda function: SimpleNamespace(fn=function)


sys.modules.setdefault("fastmcp", SimpleNamespace(FastMCP=FakeFastMCP))


def load(name: str, file: Path):
    spec = importlib.util.spec_from_file_location(name, file)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class AcceptanceFixtureTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.script = load(
            "acceptance_script",
            ROOT / "skill" / "scripts" / "calculate_acceptance_total.py",
        )
        cls.server = load(
            "acceptance_mcp",
            ROOT / "skill" / "mcp" / "acceptance_server.py",
        )

    def test_fixed_order_001(self):
        order = getattr(self.server.get_acceptance_order, "fn", self.server.get_acceptance_order)(order_id="ORDER-001")
        result = self.script.calculate_acceptance_total(order["subtotal"], order["tax_rate"])
        self.assertEqual(result["tax_amount"], "6.00")
        self.assertEqual(result["total"], "106.00")

    def test_holdout_order_002(self):
        order = getattr(self.server.get_acceptance_order, "fn", self.server.get_acceptance_order)(order_id="ORDER-002")
        result = self.script.calculate_acceptance_total(order["subtotal"], order["tax_rate"])
        self.assertEqual(result["tax_amount"], "32.50")
        self.assertEqual(result["total"], "282.50")

    def test_missing_order_is_an_error(self):
        call = getattr(self.server.get_acceptance_order, "fn", self.server.get_acceptance_order)
        with self.assertRaises(ValueError):
            call(order_id="ORDER-404")

    def test_rejected_order_is_explicit(self):
        call = getattr(self.server.get_acceptance_order, "fn", self.server.get_acceptance_order)
        order = call(order_id="ORDER-REJECTED")
        self.assertFalse(order["approved"])

    def test_invalid_order_reaches_script_error(self):
        call = getattr(self.server.get_acceptance_order, "fn", self.server.get_acceptance_order)
        order = call(order_id="ORDER-INVALID")
        with self.assertRaises(ValueError):
            self.script.calculate_acceptance_total(order["subtotal"], order["tax_rate"])

    def test_suite_ids_are_unique(self):
        suite = json.loads((ROOT / "suite.json").read_text(encoding="utf-8"))
        ids = [case["caseId"] for case in suite["cases"] + suite["holdoutCases"]]
        self.assertEqual(len(ids), len(set(ids)))


if __name__ == "__main__":
    unittest.main()
