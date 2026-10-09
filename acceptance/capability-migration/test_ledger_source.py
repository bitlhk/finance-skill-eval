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

    def open(self, amounts):
        payload = {"customer_id": "TEST", "currency": "CNY", "items": [
            {"outstanding": amount, "description": "large business response " * 100} for amount in amounts]}
        with patch.dict("os.environ", {"LEDGER_SERVICE_URL": "https://fixture.invalid"}), patch.object(
                self.module, "urlopen", return_value=io.BytesIO(json.dumps(payload).encode())):
            return self.module.open_ledger("TEST")

    def test_large_response_stays_tool_side_and_handle_is_opaque(self):
        opened = self.open(["12.34"] * 200)
        self.assertEqual(opened["record_count"], 200)
        self.assertLess(len(json.dumps(opened)), 200)
        self.assertNotIn("items", opened)
        self.assertEqual(self.module.summarize_ledger(opened["ledger_ref"])["outstanding"], "2468.00")

    def test_decimal_precision_and_empty_ledger(self):
        for values, expected in [(["0.10", "0.20", "0.30"], "0.60"), ([], "0.00")]:
            opened = self.open(values)
            self.assertEqual(self.module.summarize_ledger(opened["ledger_ref"])["outstanding"], expected)

    def test_release_and_forgery_fail_closed(self):
        opened = self.open(["1.00"])
        self.assertEqual(self.module.close_ledger(opened["ledger_ref"]), {"status": "closed"})
        for ref in [opened["ledger_ref"], "forged-ref-000"]:
            self.assertEqual(self.module.summarize_ledger(ref)["error"], "LEDGER_REFERENCE_INVALID")
            self.assertEqual(self.module.close_ledger(ref)["error"], "LEDGER_REFERENCE_INVALID")

    def test_handle_is_not_available_in_another_service_instance(self):
        ref = self.open(["99.00"])["ledger_ref"]
        self.assertEqual(load_source().summarize_ledger(ref)["error"], "LEDGER_REFERENCE_INVALID")

    def test_missing_customer_never_creates_handle(self):
        with patch.dict("os.environ", {"LEDGER_SERVICE_URL": "https://fixture.invalid"}), patch.object(
                self.module, "urlopen", side_effect=HTTPError("fixture", 404, "not found", {}, None)):
            result = self.module.open_ledger("MISSING")
        self.assertEqual(result, {"status": "not_found", "customer_id": "MISSING"})
        self.assertEqual(self.module._ledgers, {})


if __name__ == "__main__":
    unittest.main()
