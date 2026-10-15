"""Source business invariants; offline tests, not real-model acceptance."""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError


def load_source():
    spec = importlib.util.spec_from_file_location("ledger_fixture", Path(__file__).parent / "receivables-ledger/source/tools/ledger.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class LedgerSourceTests(unittest.TestCase):
    def setUp(self):
        self.module = load_source()

    def query(self, amounts):
        payload = {"customer_id": "TEST", "currency": "CNY", "items": [
            {"invoice_id": f"INV-{index+1}", "outstanding": amount, "description": "large business response " * 100}
            for index, amount in enumerate(amounts)]}
        with patch.dict("os.environ", {"LEDGER_SERVICE_URL": "https://fixture.invalid"}), patch.object(
                self.module, "urlopen", return_value=io.BytesIO(json.dumps(payload).encode())):
            return self.module.query_receivables("TEST")

    def test_large_response_stays_tool_side_and_preview_is_explicitly_incomplete(self):
        queried = self.query(["12.34"] * 200)
        self.assertEqual(queried["record_count"], 200)
        self.assertLess(len(json.dumps(queried)), 1000)
        self.assertNotIn("items", queried)
        self.assertFalse(queried["preview_complete"])
        self.assertEqual(len(queried["invoice_preview"]), 10)
        self.assertEqual(self.module.summarize_receivables(queried["snapshot_ref"])["outstanding"], "2468.00")

    def test_decimal_precision_and_empty_ledger(self):
        for values, expected in [(["0.10", "0.20", "0.30"], "0.60"), ([], "0.00")]:
            queried = self.query(values)
            self.assertTrue(queried["preview_complete"])
            self.assertEqual(self.module.summarize_receivables(queried["snapshot_ref"])["outstanding"], expected)

    def test_consumer_uses_exact_selected_records_not_the_latest_query(self):
        first = self.query(["12.34"] * 200)
        self.query(["99.00"])
        result = self.module.summarize_receivables(first["snapshot_ref"], ["INV-1", "INV-3"])
        self.assertEqual(result["outstanding"], "24.68")
        self.assertEqual(result["record_count"], 2)
        # Selection is consumed from the full snapshot, not only the visible preview.
        self.assertEqual(self.module.summarize_receivables(first["snapshot_ref"], ["INV-200"])["outstanding"], "12.34")

    def test_invalid_selection_never_falls_back_to_all_invoices(self):
        ref = self.query(["1.00"])["snapshot_ref"]
        for selection in [[], ["INV-999"], ["INV-1", "INV-1"]]:
            self.assertEqual(self.module.summarize_receivables(ref, selection)["error"], "INVOICE_SELECTION_INVALID")
        self.assertEqual(self.module.summarize_receivables("forged-ref-000")["error"], "RECEIVABLES_SNAPSHOT_INVALID")

    def test_new_instance_requeries_instead_of_reusing_an_old_snapshot(self):
        ref = self.query(["99.00"])["snapshot_ref"]
        self.assertEqual(load_source().summarize_receivables(ref)["error"], "RECEIVABLES_SNAPSHOT_INVALID")

    def test_missing_customer_never_creates_snapshot(self):
        with patch.dict("os.environ", {"LEDGER_SERVICE_URL": "https://fixture.invalid"}), patch.object(
                self.module, "urlopen", side_effect=HTTPError("fixture", 404, "not found", {}, None)):
            result = self.module.query_receivables("MISSING")
        self.assertEqual(result, {"status": "not_found", "customer_id": "MISSING"})
        self.assertEqual(self.module._snapshots, {})


if __name__ == "__main__":
    unittest.main()
