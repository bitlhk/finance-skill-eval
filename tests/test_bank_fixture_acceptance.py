"""Offline only: python3 -m unittest discover -s tests -p test_bank_fixture_acceptance.py -v"""

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "bank_fixture_acceptance.py"
MODULE = importlib.util.spec_from_file_location("bank_fixture_acceptance", SCRIPT)
bank = importlib.util.module_from_spec(MODULE)
MODULE.loader.exec_module(bank)


def sample():
    spec = {"fixtureId": "bank-test-v2", "version": "1.0.4",
            "syntheticOnly": True,
            "scope": {"mode": "all", "authorizedAccountIds": ["acct-A", "acct-B"],
                      "accountIds": ["acct-A", "acct-B"]}}
    captures = []
    for index, name in enumerate(("baseline", "before", "tool", "after")):
        timestamp = f"2026-10-02T00:00:0{index}Z"
        body = {"requestId": "request-" + name, "status": "SUCCESS", "sourceSystem": "SYNTHETIC_BANK",
                "asOf": timestamp, "error": None, "data": [
                    {"accountId": "acct-A", "availableBalance": "123.45", "ledgerBalance": "150.00",
                     "currency": "CNY", "asOf": "2026-10-01T00:00:00Z", "stale": False},
                    {"accountId": "acct-B", "availableBalance": "678.90", "ledgerBalance": "700.00",
                     "currency": "USD", "asOf": "2026-10-01T00:00:00Z", "stale": False}]}
        body["data"] = {"accounts": body["data"], "recentTransactions": {}, "stale": False, "nextPageToken": None}
        raw = json.dumps(body).encode()
        receipt = {"syntheticOnly": True, "basis": "INDEPENDENT_AUTHORIZED_READ_NOT_MODEL_OUTPUT",
                   "capturedAt": timestamp, "subjectRef": "customer-test", "route": "/api/v1/accounts",
                   "rawResponseSha256": bank.digest(raw), "sourceSystem": body["sourceSystem"],
                   "sourceAsOf": timestamp, "databaseSnapshotVersion": None, "businessWriteCalls": 0,
                   "policySha256": "a" * 64, "extraUnrecognizedField": None}
        captures.append({"raw": raw, "receipt": receipt})
    fixture = bank.generate_fixture(spec, captures[0])
    binding = {"runId": "run-test", "side": "right", "caseId": "BANK-V2-001", "toolRequestId": "request-tool",
               "fixtureSha256": bank.digest(bank.encoded(fixture).encode()), "fileMarker": "BANK_TEST_V2_MARKER"}
    output = {"sourceSystem": "SYNTHETIC_BANK", "asOf": "2026-10-02T00:00:02Z",
              "accounts": [{"accountId": "acct-A", "currency": "CNY", "availableBalance": "123.45"},
                           {"accountId": "acct-B", "currency": "USD", "availableBalance": "678.90"}],
              "fileMarker": binding["fileMarker"]}
    execution = {"binding": deepcopy(binding), "status": "completed", "streamCompleted": True,
                 "runtimeIdentityVerified": True, "traceComplete": True, "error": None,
                 "output": json.dumps(output), "attempts": [
                     {"name": "account_balance_query", "status": "completed", "sideEffect": "read", "requestId": "request-tool"},
                     {"name": "read_case_file", "status": "completed", "sideEffect": "read"}]}
    return spec, captures, binding, execution


class BankFixtureTests(unittest.TestCase):
    def setUp(self):
        self.spec, self.captures, self.binding, self.execution = sample()
        self.fixture = bank.generate_fixture(self.spec, self.captures[0])
        self.case = bank.generate_case(self.fixture, self.binding["caseId"], self.binding["fileMarker"])

    def verify(self):
        return bank.verify_fixture(self.fixture, *self.captures, self.binding, self.execution)

    def assert_rejected(self, check="facts"):
        result = self.verify()
        self.assertEqual(result["verdict"], "FAIL", result)
        self.assertEqual(result["checks"][check]["verdict"], "FAIL", result)
        return result

    def change_response(self, index, change):
        body = json.loads(self.captures[index]["raw"])
        change(body)
        self.captures[index]["raw"] = json.dumps(body).encode()
        self.captures[index]["receipt"].update(rawResponseSha256=bank.digest(self.captures[index]["raw"]),
                                             sourceAsOf=body.get("asOf"), sourceSystem=body.get("sourceSystem"))

    def change_answer(self, change):
        answer = json.loads(self.execution["output"])
        change(answer)
        self.execution["output"] = json.dumps(answer)

    def projection(self):
        self.captures[2] = None
        self.binding.pop("toolRequestId", None)
        self.binding["providerBinding"] = {"hostRequestId": "host-request-1", "harnessRequestId": "harness-request-1",
                                           "receiptId": "receipt-1", "version": "projection-v1"}
        self.execution["binding"] = deepcopy(self.binding)
        self.execution["attempts"][0].pop("requestId", None)
        self.execution["attempts"][0]["providerBinding"] = deepcopy(self.binding["providerBinding"])
        return {"captureLocation": "PROVIDER/TOOL_RESULT", "sourcePath": "toolResults[data.result]",
                "syntheticOnly": True, "hostIdentityVerified": True,
                "binding": deepcopy(self.binding["providerBinding"]),
                "facts": {"sourceSystem": "SYNTHETIC_BANK", "accounts": deepcopy(self.fixture["expectedAccounts"])}}

    def verify_projection(self, projection):
        return bank.verify_fixture(self.fixture, *self.captures, self.binding, self.execution, projection)

    def test_missing_http_still_reports_before_after_and_answer(self):
        self.captures[2] = None
        self.binding.pop("toolRequestId")
        self.execution["binding"] = deepcopy(self.binding)
        self.execution["attempts"][0].pop("requestId")
        self.change_answer(lambda a: a.pop("asOf"))
        result = self.verify()
        self.assertEqual(result["verdict"], "INDETERMINATE", result)
        for name in ("beforeAfter", "answer", "execution"):
            self.assertEqual(result["checks"][name]["verdict"], "PASS", result)
        self.assertEqual(result["checks"]["toolHTTP"]["verdict"], "INDETERMINATE")
        self.assertEqual(result["checks"]["answerTime"]["verdict"], "INDETERMINATE")

    def test_provider_projection_without_http_request_id_is_not_http_pass(self):
        projection = self.projection()
        self.change_answer(lambda a: a.pop("asOf"))
        result = self.verify_projection(projection)
        self.assertEqual(result["verdict"], "INDETERMINATE", result)
        for name in ("beforeAfter", "answer", "providerProjection", "execution"):
            self.assertEqual(result["checks"][name]["verdict"], "PASS", result)
        self.assertEqual(result["checks"]["providerProjection"]["captureLocation"], "PROVIDER/TOOL_RESULT")
        self.assertNotIn("requestId", projection)
        self.assertNotIn("rawSha256", result["checks"]["providerProjection"])
        self.assertNotIn("toolRequestId", self.binding)

    def test_provider_time_is_labeled_provider_not_http(self):
        projection = self.projection()
        projection["asOf"] = "2026-10-02T00:00:02Z"
        result = self.verify_projection(projection)
        self.assertEqual(result["checks"]["answerTime"], {"verdict": "PASS", "captureLocation": "PROVIDER/TOOL_RESULT"})
        self.assertEqual(result["verdict"], "INDETERMINATE")
        self.change_answer(lambda a: a.update(asOf="2026-10-02T00:00:00Z"))
        self.assertEqual(self.verify_projection(projection)["verdict"], "FAIL")

    def test_projection_binding_and_verification_negatives(self):
        for key in ("hostRequestId", "harnessRequestId", "receiptId", "version"):
            self.setUp()
            projection = self.projection()
            projection["binding"][key] = "wrong"
            result = self.verify_projection(projection)
            self.assertEqual(result["checks"]["providerProjection"]["verdict"], "FAIL", result)
            self.assertEqual(result["verdict"], "FAIL")
        for key, value in (("hostIdentityVerified", False), ("syntheticOnly", False),
                           ("captureLocation", "BANK/HTTP"), ("sourcePath", "model.output")):
            self.setUp()
            projection = self.projection()
            projection[key] = value
            self.assertEqual(self.verify_projection(projection)["verdict"], "FAIL")

    def test_projection_cannot_supply_fixture_expectations(self):
        projection = self.projection()
        projection["facts"]["accounts"][0]["availableBalance"] = "999.99"
        self.change_answer(lambda a: a["accounts"][0].update(availableBalance="999.99"))
        result = self.verify_projection(projection)
        self.assertEqual(result["checks"]["answer"]["verdict"], "FAIL")
        self.assertEqual(result["checks"]["providerProjection"]["verdict"], "FAIL")
        self.assertEqual(result["checks"]["beforeAfter"]["verdict"], "PASS")
        self.assertEqual(self.fixture["expectedAccounts"][0]["availableBalance"], "123.45")

    def test_missing_projection_or_attempt_binding_rejected(self):
        projection = self.projection()
        self.assertEqual(self.verify()["checks"]["providerProjection"]["verdict"], "FAIL")
        self.execution["attempts"][0].pop("providerBinding")
        result = self.verify_projection(projection)
        self.assertEqual(result["checks"]["execution"]["verdict"], "FAIL")

    def test_projection_does_not_hide_drift_or_failed_attempt(self):
        projection = self.projection()
        self.change_response(3, lambda b: b["data"]["accounts"][0].update(availableBalance="999.99"))
        self.assertEqual(self.verify_projection(projection)["checks"]["beforeAfter"]["verdict"], "FAIL")
        self.setUp()
        projection = self.projection()
        self.execution["attempts"].insert(0, {"name": "account_balance_query", "status": "failed", "sideEffect": "read"})
        result = self.verify_projection(projection)
        self.assertEqual(result["verdict"], "FAIL")
        self.assertEqual(result["checks"]["providerProjection"]["verdict"], "PASS")

    def test_raw_http_remains_strict_about_location_and_root_request(self):
        for target in ("capture", "receipt"):
            self.setUp()
            declaration = self.captures[2] if target == "capture" else self.captures[2]["receipt"]
            declaration["captureLocation"] = "PROVIDER/TOOL_RESULT"
            self.assertEqual(self.verify()["checks"]["toolHTTP"]["verdict"], "FAIL")
        self.setUp()
        self.change_response(2, lambda b: b.pop("requestId"))
        self.assertEqual(self.verify()["checks"]["toolHTTP"]["verdict"], "FAIL")
        self.captures[0]["captureLocation"] = "PROVIDER/TOOL_RESULT"
        with self.assertRaises(ValueError):
            bank.generate_fixture(self.spec, self.captures[0])

    def test_valid_readonly_and_variable_root_time(self):
        with patch("socket.socket", side_effect=AssertionError("network forbidden")):
            result = self.verify()
        self.assertEqual(result["verdict"], "PASS", result)
        self.assertEqual(result["judge"], "NOT_ASSESSED")
        self.assertNotEqual(self.fixture["baseline"]["asOf"], "2026-10-02T00:00:02Z")
        self.assertIn("123.45", self.case["evaluationGoal"])
        self.assertIn("123.45", self.case["rubric"][0]["description"])
        self.assertNotIn("123.45", self.case["prompt"])

    def test_generation_is_reproducible(self):
        again = bank.generate_fixture(deepcopy(self.spec), deepcopy(self.captures[0]))
        self.assertEqual(again, self.fixture)

    def test_unknown_provenance_preserved_without_runtime_or_db_attestation(self):
        baseline = self.fixture["baseline"]
        self.assertIsNone(baseline["receipt"]["databaseSnapshotVersion"])
        self.assertIsNone(baseline["receipt"]["extraUnrecognizedField"])
        self.assertIsNone(baseline["identity"]["bankBuild"])
        self.assertNotIn("runtimeHostLock", self.fixture)
        self.assertNotIn("caseId", self.fixture)
        self.assertNotIn("dataVersion", baseline)
        self.assertEqual(baseline["receipt"], self.captures[0]["receipt"])
        self.assertEqual(baseline["observationSnapshot"]["basis"], "INDEPENDENT_CAPTURE_FACTS_NOT_DB_ATTESTATION")
        self.assertEqual(baseline["observationSnapshot"]["factsSha256"],
                         bank.digest(bank.encoded(baseline["facts"]).encode()))

    def test_model_output_not_accepted_by_generation_api(self):
        self.spec["output"] = self.execution["output"]
        with self.assertRaisesRegex(ValueError, "data identity and scope only"):
            bank.generate_fixture(self.spec, self.captures[0])

    def test_receipt_requires_independent_raw_evidence(self):
        for key, value in (("basis", "MODEL_ANSWER"), ("rawResponseSha256", "b" * 64),
                           ("sourceAsOf", "2026-10-02T01:00:00Z"), ("sourceSystem", "other"),
                           ("businessWriteCalls", 1), ("businessWriteCalls", False), ("syntheticOnly", False)):
            self.setUp()
            self.captures[2]["receipt"][key] = value
            self.assert_rejected()
        self.setUp()
        self.captures[2]["receipt"].pop("databaseSnapshotVersion")
        self.assert_rejected()

    def test_capture_order_and_reused_request_rejected(self):
        self.captures[3]["receipt"]["capturedAt"] = "2026-10-01T00:00:00Z"
        self.assert_rejected()
        self.setUp()
        self.change_response(3, lambda b: b.update(requestId="request-before"))
        self.assert_rejected()

    def test_baseline_can_also_be_immediate_before_capture(self):
        self.captures[1] = deepcopy(self.captures[0])
        self.assertEqual(self.verify()["verdict"], "PASS")

    def test_account_scope_missing_or_unauthorized_rejected(self):
        for ids in (["acct-C"], ["acct-A", "acct-A"], []):
            self.setUp()
            self.spec["scope"]["accountIds"] = ids
            with self.assertRaises(ValueError):
                bank.generate_fixture(self.spec, self.captures[0])
        self.setUp()
        self.spec["scope"]["authorizedAccountIds"] = ["acct-A"]
        with self.assertRaises(ValueError):
            bank.generate_fixture(self.spec, self.captures[0])

    def test_missing_ledger_is_explicit_not_available_balance_fallback(self):
        self.change_response(0, lambda b: b["data"]["accounts"][0].pop("ledgerBalance"))
        fixture = bank.generate_fixture(self.spec, self.captures[0])
        account = fixture["baseline"]["facts"]["accounts"][0]
        self.assertIsNone(account["ledgerBalance"])
        self.assertEqual(account["missing"], ["ledgerBalance"])
        self.change_response(0, lambda b: b["data"]["accounts"][0].pop("availableBalance"))
        with self.assertRaises(ValueError):
            bank.generate_fixture(self.spec, self.captures[0])

    def test_exact_json_numeric_amount_without_float_rounding(self):
        raw = self.captures[0]["raw"].replace(b'"123.45"', b'9007199254740993.1234567890123456789')
        summary = bank.summarize(raw)
        self.assertEqual(summary["facts"]["accounts"][0]["availableBalance"], "9007199254740993.1234567890123456789")
        raw = self.captures[0]["raw"].replace(b'"123.45"', b'0.00000001')
        self.assertEqual(bank.summarize(raw)["facts"]["accounts"][0]["availableBalance"], "0.00000001")

    def test_unknown_numeric_receipt_fields_roundtrip_exactly(self):
        extra = bank.parse_json(b'{"futureField":1234567890123456789.123456789}')
        self.captures[0]["receipt"].update(extra)
        fixture = bank.generate_fixture(self.spec, self.captures[0])
        self.assertEqual(bank.parse_json(bank.encoded(fixture)), fixture)
        self.assertEqual(fixture["baseline"]["receipt"]["futureField"], extra["futureField"])

    def test_zero_negative_and_decimal_scale(self):
        for value, expected in [("0.00", "0"), ("-0.0", "0"), ("-12.3400", "-12.34")]:
            self.assertEqual(bank.decimal_amount(value), expected)
        for bad in (None, True, 0.1, "***", "NaN", "1,000.00", "1e3", ""):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                bank.decimal_amount(bad)

    def test_wrong_account_amount_currency_and_missing_fields(self):
        for key, value in (("accountId", "acct-other"), ("availableBalance", "123.46"),
                           ("currency", "USD"), ("availableBalance", None)):
            with self.subTest(key=key, value=value):
                self.setUp()
                self.change_answer(lambda a: a["accounts"][0].update({key: value}))
                self.assert_rejected()
        for key in ("accountId", "availableBalance", "currency"):
            self.setUp()
            self.change_answer(lambda a: a["accounts"][0].pop(key))
            self.assert_rejected()

    def test_cross_account_amount_swap_is_not_a_bag_of_numbers(self):
        def swap(answer):
            answer["accounts"][0]["availableBalance"], answer["accounts"][1]["availableBalance"] = "678.90", "123.45"
        self.change_answer(swap)
        self.assert_rejected()

    def test_duplicate_extra_and_missing_answer_accounts(self):
        for mutate in (lambda a: a["accounts"].append(a["accounts"][0]),
                       lambda a: a["accounts"].pop(), lambda a: a.update(accounts=[])):
            self.setUp()
            self.change_answer(mutate)
            self.assert_rejected()

    def test_formatting_and_row_order_are_not_fact_drift(self):
        self.change_response(3, lambda b: b["data"]["accounts"].reverse())
        self.change_answer(lambda a: a["accounts"].reverse())
        self.change_answer(lambda a: a["accounts"][1].update(availableBalance="123.4500"))
        self.assertEqual(self.verify()["verdict"], "PASS")

    def test_before_tool_after_drift(self):
        for index in (1, 2, 3):
            for key, value in (("availableBalance", "999.00"), ("ledgerBalance", "999.00"),
                               ("currency", "EUR"), ("accountId", "wrong"), ("version", 2),
                               ("asOf", "2026-10-02T00:00:00Z")):
                with self.subTest(index=index, key=key):
                    self.setUp()
                    self.change_response(index, lambda b: b["data"]["accounts"][0].update({key: value}))
                    self.assert_rejected()

    def test_missing_redacted_duplicate_stale_and_failed_sources(self):
        mutations = [lambda b: b.update(data=None), lambda b: b.update(data=[]),
                     lambda b: b.update(status="FAILED"), lambda b: b.pop("sourceSystem"),
                     lambda b: b.update(sourceSystem="redacted"),
                     lambda b: b["data"]["accounts"][0].pop("availableBalance"),
                     lambda b: b["data"]["accounts"][0].update(availableBalance="***"),
                     lambda b: b["data"]["accounts"][0].update(stale=True),
                     lambda b: b["data"].update(stale=True),
                     lambda b: b["data"].update(nextPageToken="page-2"),
                     lambda b: b["data"].update(accounts=None),
                     lambda b: b["data"]["accounts"].append(b["data"]["accounts"][0])]
        for mutate in mutations:
            self.setUp()
            self.change_response(2, mutate)
            self.assert_rejected()

    def test_duplicate_json_keys_and_nonfinite_rejected(self):
        for raw in (b'{"x":1,"x":2}', b'{"x":NaN}', b'{"x":Infinity}'):
            with self.assertRaises(ValueError):
                bank.parse_json(raw)

    def test_raw_byte_digest_not_reserialization(self):
        old = self.fixture["baseline"]["rawSha256"]
        self.captures[0]["raw"] += b"\n"
        self.assertNotEqual(bank.summarize(self.captures[0]["raw"])["rawSha256"], old)
        self.assert_rejected()

    def test_old_fixture_or_tampered_expectation_rejected(self):
        self.fixture["expectedAccounts"][0]["availableBalance"] = "12345.67"
        self.assert_rejected()
        self.setUp()
        self.fixture["fixtureId"] = "old-fixture"
        self.execution["binding"]["fixtureSha256"] = "b" * 64
        self.assert_rejected("execution")

    def test_source_and_context_drift(self):
        self.change_response(3, lambda b: b.update(sourceSystem="OTHER_BANK"))
        self.assert_rejected()
        for key in self.fixture["baseline"]["identity"]:
            self.setUp()
            self.captures[3]["receipt"][key] = {"accountId": "other"} if key == "parameters" else "other"
            self.assert_rejected()

    def test_asof_policy(self):
        for bad in ("2026-10-02T00:00:00Z", None, "yesterday"):
            self.setUp()
            self.change_answer(lambda a: a.update(asOf=bad))
            self.assert_rejected()
        self.setUp()
        self.change_response(2, lambda b: b.update(asOf="2026-02-30T00:00:00Z"))
        self.assert_rejected()

    def test_missing_or_wrong_source_marker(self):
        for key in ("sourceSystem", "fileMarker"):
            self.setUp()
            self.change_answer(lambda a: a.pop(key))
            self.assert_rejected()

    def test_missing_or_cross_request_evidence(self):
        self.change_response(2, lambda b: b.update(requestId="other"))
        self.assert_rejected()
        self.setUp()
        self.captures[2]["receipt"]["requestId"] = "other"
        self.change_response(2, lambda b: b.update(requestId="other"))
        self.assert_rejected()
        for key in self.binding:
            self.setUp()
            self.execution["binding"][key] = "other"
            self.assert_rejected("execution")

    def test_failed_oj_attempt_then_success_stays_failed(self):
        self.execution["attempts"].insert(0, {"name": "account_balance_query", "status": "failed", "sideEffect": "read"})
        result = self.assert_rejected("execution")
        self.assertEqual(result["checks"]["facts"]["verdict"], "PASS")

    def test_completed_job_does_not_override_failed_execution(self):
        for key, value in (("status", "failed"), ("error", "MODEL_OR_RUNTIME_FAILED"),
                           ("traceComplete", False), ("streamCompleted", False),
                           ("runtimeIdentityVerified", False), ("attempts", [])):
            self.setUp()
            self.execution[key] = value
            self.execution["jobStatus"] = "completed"
            self.assert_rejected("execution")

    def test_write_unknown_side_effect_missing_tool_rejected(self):
        for value in ("write", "unknown", None):
            self.setUp()
            self.execution["attempts"][0]["sideEffect"] = value
            self.assert_rejected("execution")
        self.setUp()
        self.execution["attempts"].pop()
        self.assert_rejected("execution")

    def test_scope_and_detail(self):
        self.spec["scope"] = {"mode": "specified", "authorizedAccountIds": ["acct-A", "acct-B"], "accountIds": ["acct-B"]}
        self.change_response(0, lambda b: b.update(data=b["data"]["accounts"][1]))
        fixture = bank.generate_fixture(self.spec, self.captures[0])
        self.assertEqual([a["accountId"] for a in fixture["expectedAccounts"]], ["acct-B"])
        self.spec["scope"]["accountIds"] = ["acct-A"]
        with self.assertRaisesRegex(ValueError, "missing"):
            bank.generate_fixture(self.spec, self.captures[0])

    def test_generation_denies_legacy_and_non_synthetic(self):
        for key, value in (("version", "1.0.3"), ("version", "1.0.2"), ("syntheticOnly", False)):
            self.setUp()
            self.spec[key] = value
            with self.assertRaises(ValueError):
                bank.generate_fixture(self.spec, self.captures[0])
        with self.assertRaises(ValueError):
            bank.generate_case(self.fixture, "NATIVE-BALANCE-001", "marker")

    def test_cli_new_files_only_replay_and_exit_codes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            descriptors = []
            for index, capture in enumerate(self.captures):
                filename = f"response-{index}.json"
                (root / filename).write_bytes(capture["raw"])
                receipt_file = f"receipt-{index}.json"
                (root / receipt_file).write_text(bank.encoded(capture["receipt"]))
                descriptors.append({"responseFile": filename, "receiptFile": receipt_file})
            source = root / "generation.json"
            source.write_text(bank.encoded({"spec": self.spec, "capture": descriptors[0]}))
            out = root / "new-case"
            command = [sys.executable, str(SCRIPT), "generate", "--input", str(source), "--out", str(out)]
            run = subprocess.run(command, capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
            original = (out / "fixture.json").read_bytes()
            self.assertFalse((out / "case.json").exists())
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 1)
            self.assertEqual((out / "fixture.json").read_bytes(), original)
            payload = dict(zip(("baseline", "before", "tool", "after"), descriptors))
            payload.update(expectedBinding=self.binding, execution=self.execution)
            acceptance = root / "acceptance.json"
            acceptance.write_text(bank.encoded(payload))
            verify = [sys.executable, str(SCRIPT), "verify", "--fixture", str(out / "fixture.json"), "--input", str(acceptance)]
            for _ in range(2):
                run = subprocess.run(verify, capture_output=True, text=True)
                self.assertEqual(run.returncode, 0, run.stdout + run.stderr)
                self.assertEqual(json.loads(run.stdout)["verdict"], "PASS")
            payload["execution"]["output"] = "Only the number 123.45 CNY"
            acceptance.write_text(bank.encoded(payload))
            run = subprocess.run(verify, capture_output=True, text=True)
            self.assertEqual(run.returncode, 1)
            self.assertEqual(json.loads(run.stdout)["verdict"], "FAIL")


if __name__ == "__main__":
    unittest.main()
