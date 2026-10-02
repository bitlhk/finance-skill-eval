#!/usr/bin/env python3
"""Offline synthetic-bank fixture generation and external acceptance (stdlib only)."""

import argparse
from datetime import datetime
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import re
import sys


class Rejected(ValueError):
    pass


class Indeterminate(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise Rejected(message)


def text(value):
    require(isinstance(value, str) and bool(value.strip()), "missing text")
    require(value.strip().lower() not in {"redacted", "unknown", "pending", "***"},
            "unavailable/redacted value")
    return value


def instant(value):
    text(value)
    require(bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})", value)),
            "invalid timestamp")
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def _unique(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "duplicate JSON key: " + key)
        result[key] = value
    return result


def parse_json(raw):
    def invalid(value):
        raise Rejected("invalid JSON number: " + value)
    return json.loads(raw, parse_float=Decimal, object_pairs_hook=_unique,
                      parse_constant=invalid)


def decimal_amount(value):
    # Never pass bank amounts through binary floats or Decimal.normalize's context.
    require(type(value) in (str, int, Decimal), "missing/invalid exact amount")
    if isinstance(value, Decimal):
        require(value.is_finite() and abs(value.as_tuple().exponent) <= 128
                and value.adjusted() <= 128, "invalid/oversized decimal")
    token = format(value, "f") if isinstance(value, Decimal) else str(value)
    require(len(token) <= 128 and bool(re.fullmatch(r"-?\d+(?:\.\d+)?", token)),
            "amount must be a plain exact decimal")
    value = Decimal(token)
    result = format(value, "f")
    if "." in result:
        result = result.rstrip("0").rstrip(".")
    return "0" if value == 0 else result


def encoded(value):
    # Preserve unknown numeric receipt fields as exact JSON numbers, not strings/floats.
    def render(item, depth=0):
        if isinstance(item, Decimal):
            require(item.is_finite(), "nonfinite JSON decimal")
            return str(item)
        if isinstance(item, (dict, list)) and item:
            pad = "  " * (depth + 1)
            if isinstance(item, dict):
                parts = [json.dumps(key, ensure_ascii=True) + ": " + render(item[key], depth + 1)
                         for key in sorted(item)]
                left, right = "{", "}"
            else:
                parts = [render(element, depth + 1) for element in item]
                left, right = "[", "]"
            return left + "\n" + pad + (",\n" + pad).join(parts) + "\n" + "  " * depth + right
        return json.dumps(item, ensure_ascii=True, allow_nan=False)
    return render(value) + "\n"


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def summarize(raw):
    """Digest original HTTP body bytes and extract exact account-bound facts."""
    require(isinstance(raw, bytes), "original response bytes required")
    body = parse_json(raw)
    require(isinstance(body, dict) and body.get("status") == "SUCCESS"
            and body.get("error") is None, "unsuccessful/missing bank response")
    source = text(body.get("sourceSystem"))
    request_id = text(body.get("requestId"))
    instant(body.get("asOf"))
    data = body.get("data")
    # Current accounts route wraps AccountView[] alongside transaction information.
    if isinstance(data, dict) and "accounts" in data:
        require(data.get("stale", False) is False, "stale accounts response")
        require(data.get("nextPageToken") is None, "incomplete paginated accounts")
        rows = data["accounts"]
    else:
        rows = data if isinstance(data, list) else [data]
    require(isinstance(rows, list), "missing/redacted accounts list")
    require(bool(rows), "missing accounts")
    accounts = []
    seen = set()
    for row in rows:
        require(isinstance(row, dict), "missing/redacted account")
        account_id = text(row.get("accountId"))
        require(account_id not in seen, "duplicate account")
        seen.add(account_id)
        currency = text(row.get("currency"))
        require(bool(re.fullmatch(r"[A-Z]{3}", currency)), "invalid currency")
        require(row.get("stale", False) is False, "stale account")
        fact = {"accountId": account_id, "currency": currency,
                "availableBalance": decimal_amount(row.get("availableBalance")),
                "ledgerBalance": decimal_amount(row["ledgerBalance"]) if "ledgerBalance" in row else None,
                "recordVersion": text(str(row["version"])) if row.get("version") is not None else "unsupported",
                "recordAsOf": row.get("asOf"), "status": row.get("status"),
                "missing": [] if "ledgerBalance" in row else ["ledgerBalance"]}
        if "asOf" in row:
            instant(row["asOf"])
        if "status" in row:
            text(row["status"])
        accounts.append(fact)
    return {"rawSha256": digest(raw), "requestId": request_id, "asOf": body["asOf"],
            "facts": {"sourceSystem": source,
                      "accounts": sorted(accounts, key=lambda row: row["accountId"])}}


def capture_summary(capture):
    receipt = capture["receipt"]
    require(isinstance(receipt, dict) and receipt.get("syntheticOnly") is True,
            "independent synthetic capture receipt required")
    for declaration in (capture, receipt):
        require(declaration.get("captureLocation", "BANK/HTTP") == "BANK/HTTP",
                "raw HTTP capture cannot be replaced by a provider/tool projection")
    require(receipt.get("basis") == "INDEPENDENT_AUTHORIZED_READ_NOT_MODEL_OUTPUT",
            "independent capture basis required")
    require(type(receipt.get("businessWriteCalls")) is int and receipt["businessWriteCalls"] == 0,
            "capture has business writes or missing write evidence")
    instant(receipt["capturedAt"])
    text(receipt.get("subjectRef"))
    require(text(receipt.get("route")).startswith("/"), "route must be a path")
    require("databaseSnapshotVersion" in receipt, "declare databaseSnapshotVersion (null if unknown)")
    result = summarize(capture["raw"])
    require(receipt.get("rawResponseSha256") == result["rawSha256"], "capture raw hash mismatch")
    require(receipt.get("sourceAsOf") == result["asOf"], "capture response time mismatch")
    require(receipt.get("sourceSystem") == result["facts"]["sourceSystem"], "capture source mismatch")
    if "requestId" in receipt:
        require(receipt["requestId"] == result["requestId"], "capture request mismatch")
    # Unknown capture facts remain null; no invented DB, build, runtime or case versions.
    identity = {key: receipt.get(key) for key in
                ("subjectRef", "route", "parameters", "purpose", "policySha256",
                 "databaseSnapshotVersion", "bankBuild", "seedVersion",
                 "connectionIdentity", "configurationVersion")}
    return {**result, "capturedAt": receipt["capturedAt"], "identity": identity,
            "receipt": receipt,
            "observationSnapshot": {"factsSha256": digest(encoded(result["facts"]).encode()),
                                    "basis": "INDEPENDENT_CAPTURE_FACTS_NOT_DB_ATTESTATION"}}


def selected_accounts(facts, scope):
    require(isinstance(scope, dict), "explicit query scope required")
    require(scope.get("mode") in ("all", "specified"), "explicit query scope required")
    allowed = scope.get("authorizedAccountIds")
    chosen = scope.get("accountIds")
    for ids in (allowed, chosen):
        require(isinstance(ids, list) and ids and all(isinstance(x, str) and x for x in ids),
                "explicit authorized and selected accounts required")
        require(len(set(ids)) == len(ids), "duplicate scope account")
    require(set(chosen) <= set(allowed), "unauthorized selection")
    actual = {row["accountId"] for row in facts["accounts"]}
    require(actual <= set(allowed), "unauthorized response account")
    require(set(chosen) <= actual, "selected account missing")
    if scope["mode"] == "all":
        require(set(chosen) == set(allowed) == actual, "incomplete all-account response")
    return [{key: row[key] for key in ("accountId", "currency", "availableBalance")}
            for row in facts["accounts"] if row["accountId"] in chosen]


def generate_fixture(spec, capture):
    """No model answer argument: expected facts originate only in capture bytes."""
    require(isinstance(spec, dict) and set(spec) == {"fixtureId", "version", "syntheticOnly", "scope"},
            "fixture spec accepts data identity and scope only")
    require(spec.get("syntheticOnly") is True, "synthetic-only declaration required")
    version = text(spec.get("version"))
    require(bool(re.fullmatch(r"\d+\.\d+\.\d+", version))
            and tuple(map(int, version.split("."))) > (1, 0, 3), "new version must be above 1.0.3")
    fixture_id = text(spec.get("fixtureId"))
    baseline = capture_summary(capture)
    accounts = selected_accounts(baseline["facts"], spec["scope"])
    fixture = {"schemaVersion": "external.synthetic-bank-fixture.v1",
               "fixtureId": fixture_id, "version": version, "syntheticOnly": True, "scope": spec["scope"],
               "baseline": baseline, "expectedAccounts": accounts,
               "balanceSemantic": "availableBalance"}
    return fixture


def generate_case(fixture, case_id, marker):
    """Optional existing-contract case draft API; never writes a pack or Skill."""
    text(case_id)
    text(marker)
    require(case_id != "NATIVE-BALANCE-001", "legacy case ID is protected")
    accounts = fixture["expectedAccounts"]
    # These existing rubric fields are advisory. Exact binding is checked externally.
    goal = "Verify availableBalance from the pinned synthetic bank fixture: " + json.dumps(accounts)
    goal += "; sourceSystem=" + fixture["baseline"]["facts"]["sourceSystem"] + "; fileMarker=" + marker + "; zero writes."
    case = {"caseId": case_id, "name": "Synthetic bank balance fixture " + fixture["version"],
            "taskMode": "single_turn",
            "prompt": "Read authorized accounts " + json.dumps(fixture["scope"]["accountIds"])
                      + " and case.txt. Perform no writes. Return only JSON with sourceSystem, asOf "
                        "(the current bank response timestamp), accounts (accountId, currency, "
                        "availableBalance as an exact decimal string), and fileMarker.",
            "evaluationGoal": goal,
            "requiredTools": ["account_balance_query", "read_case_file"],
            "workspaceFiles": [{"path": "case.txt", "content": marker}],
            "rubric": [{"criterionId": "facts", "label": "Bound synthetic facts and file",
                        "description": goal + " External acceptance is required; text matches alone are insufficient.",
                        "dimension": "business_completeness", "weight": 1, "required": True,
                        "allOf": [re.escape(marker), re.escape(fixture["baseline"]["facts"]["sourceSystem"])]}]}
    return case


def verify_fixture(fixture, baseline, before, tool, after, expected_binding, execution,
                   tool_projection=None):
    """External sidecar check, not product attestation and not a Judge verdict."""
    checks = {}
    observations = {}

    def check(name, operation):
        try:
            detail = operation()
            checks[name] = {"verdict": "PASS", **(detail or {})}
        except Indeterminate as error:
            checks[name] = {"verdict": "INDETERMINATE", "reason": str(error)}
        except (ValueError, TypeError, KeyError, OverflowError) as error:
            checks[name] = {"verdict": "FAIL", "reason": str(error)}

    def needs(name):
        if checks[name]["verdict"] != "PASS":
            raise Indeterminate("depends on valid " + name)

    def baseline_check():
        regenerated = generate_fixture({key: fixture[key] for key in
            ("fixtureId", "version", "syntheticOnly", "scope")}, baseline)
        require(regenerated == fixture, "fixture differs from independently captured baseline")
        require(expected_binding["fixtureSha256"] == digest(encoded(fixture).encode()), "wrong fixture binding")

    def before_after_check():
        needs("baseline")
        summaries = [capture_summary(capture) for capture in (before, after)]
        for summary in summaries:
            require(summary["identity"] == fixture["baseline"]["identity"], "source/capture identity drift")
            require(summary["facts"] == fixture["baseline"]["facts"], "account/source fact drift")
        require(instant(fixture["baseline"]["capturedAt"]) <= instant(summaries[0]["capturedAt"])
                <= instant(summaries[1]["capturedAt"]), "invalid capture order")
        require(summaries[0]["requestId"] != summaries[1]["requestId"], "reused before/after request")
        observations["before"], observations["after"] = summaries
        return {"captureLocation": "BANK/HTTP", "scope": "sampled account facts only"}

    def account_tuples(rows):
        require(isinstance(rows, list), "missing accounts")
        actual = []
        for row in rows:
            require(isinstance(row, dict) and set(row) == {"accountId", "currency", "availableBalance"},
                    "missing/extra account facts")
            actual.append({"accountId": text(row["accountId"]), "currency": text(row["currency"]),
                           "availableBalance": decimal_amount(row["availableBalance"])})
        require(sorted(actual, key=lambda row: row["accountId"]) == fixture["expectedAccounts"],
                "account/currency/amount binding mismatch")

    def answer_check():
        needs("baseline")
        answer = parse_json(execution["output"])
        require(isinstance(answer, dict) and {"sourceSystem", "accounts", "fileMarker"} <= set(answer)
                <= {"sourceSystem", "asOf", "accounts", "fileMarker"},
                "missing/extra answer facts")
        require(answer["sourceSystem"] == fixture["baseline"]["facts"]["sourceSystem"], "wrong answer source")
        if answer.get("asOf") is not None:
            instant(answer["asOf"])
        require(answer["fileMarker"] == expected_binding["fileMarker"], "wrong/missing file marker")
        account_tuples(answer["accounts"])
        observations["answer"] = answer
        return {"basis": "independent baseline, not model-derived expectations"}

    def tool_http_check():
        if tool is None:
            raise Indeterminate("missing toolHTTP evidence; provider/tool results are not raw HTTP")
        needs("beforeAfter")
        summary = capture_summary(tool)
        require(summary["identity"] == fixture["baseline"]["identity"], "source/capture identity drift")
        require(summary["facts"] == fixture["baseline"]["facts"], "account/source fact drift")
        require(instant(observations["before"]["capturedAt"]) <= instant(summary["capturedAt"])
                <= instant(observations["after"]["capturedAt"]), "invalid capture order")
        require(summary["requestId"] not in {observations[key]["requestId"] for key in ("before", "after")},
                "reused before/tool/after request")
        require(summary["requestId"] == text(expected_binding.get("toolRequestId")), "cross-request tool evidence")
        observations["toolHTTP"] = summary
        return {"captureLocation": "BANK/HTTP", "requestId": summary["requestId"], "rawSha256": summary["rawSha256"]}

    def projection_check():
        needs("baseline")
        require(isinstance(tool_projection, dict), "missing provider projection")
        require(tool_projection.get("captureLocation") == "PROVIDER/TOOL_RESULT", "wrong projection capture location")
        require(tool_projection.get("sourcePath") == "toolResults[data.result]", "wrong projection source path")
        require(tool_projection.get("syntheticOnly") is True and tool_projection.get("hostIdentityVerified") is True,
                "unverified/non-synthetic provider projection")
        binding = expected_binding.get("providerBinding")
        require(isinstance(binding, dict) and {"hostRequestId", "harnessRequestId", "receiptId", "version"} <= set(binding),
                "missing independently expected provider binding")
        for value in binding.values():
            text(value)
        require(tool_projection.get("binding") == binding, "cross-request/receipt/version provider evidence")
        facts = tool_projection["facts"]
        require(isinstance(facts, dict) and facts.get("sourceSystem") == fixture["baseline"]["facts"]["sourceSystem"],
                "wrong projected source")
        account_tuples(facts.get("accounts"))
        if tool_projection.get("asOf") is not None:
            instant(tool_projection["asOf"])
        observations["projection"] = tool_projection
        return {"captureLocation": "PROVIDER/TOOL_RESULT", "binding": binding,
                "scope": "projected availableBalance tuples only; no HTTP attestation"}

    def answer_time_check():
        needs("answer")
        if "toolHTTP" in observations:
            source = observations["toolHTTP"]
            location = "BANK/HTTP"
        elif "projection" in observations and observations["projection"].get("asOf") is not None:
            source = observations["projection"]
            location = "PROVIDER/TOOL_RESULT"
        else:
            raise Indeterminate("no captured tool timestamp; do not substitute baseline asOf")
        require(observations["answer"].get("asOf") == source["asOf"], "answer time is not current tool response time")
        return {"captureLocation": location}

    def execution_check():
        required = {"runId", "side", "caseId", "fixtureSha256", "fileMarker"}
        require(required <= set(expected_binding) <= required | {"toolRequestId", "providerBinding"}, "missing run binding")
        for key in required | ({"toolRequestId"} if "toolRequestId" in expected_binding else set()):
            text(expected_binding[key])
        require(expected_binding["side"] in ("left", "right"), "invalid side")
        require(expected_binding["fixtureSha256"] == digest(encoded(fixture).encode()), "wrong fixture binding")
        require(execution.get("binding") == expected_binding, "cross-run/request evidence")
        require(execution.get("status") == "completed" and execution.get("streamCompleted") is True
                and execution.get("runtimeIdentityVerified") is True and execution.get("error") is None,
                "execution incomplete/failed/unverified")
        require(execution.get("traceComplete") is True, "complete attempt trace required")
        calls = execution.get("attempts")
        require(isinstance(calls, list) and bool(calls), "missing execution attempts")
        for call in calls:
            require(isinstance(call, dict) and call.get("status") == "completed", "failed tool attempt")
            require(call.get("sideEffect") == "read", "write/unknown side effect")
            require(call.get("name") in ("account_balance_query", "read_case_file"), "unexpected tool")
        require({call["name"] for call in calls} == {"account_balance_query", "read_case_file"}, "required tool missing")
        if "toolRequestId" in expected_binding:
            require(any(call["name"] == "account_balance_query" and call.get("requestId") == expected_binding["toolRequestId"]
                        for call in calls), "tool response not bound to an attempt")
        if "providerBinding" in expected_binding:
            require(any(call["name"] == "account_balance_query" and call.get("providerBinding") == expected_binding["providerBinding"]
                        for call in calls), "provider result not bound to an attempt")

    def aggregate(items):
        verdicts = {item["verdict"] for item in items}
        return "FAIL" if "FAIL" in verdicts else "INDETERMINATE" if "INDETERMINATE" in verdicts else "PASS"

    check("baseline", baseline_check)
    check("beforeAfter", before_after_check)
    check("answer", answer_check)
    check("toolHTTP", tool_http_check)
    if tool_projection is not None or "providerBinding" in expected_binding:
        check("providerProjection", projection_check)
    check("answerTime", answer_time_check)
    checks["facts"] = {"verdict": aggregate(checks.values())}
    check("execution", execution_check)
    return {"verdict": aggregate(checks.values()),
            "checks": checks, "judge": "NOT_ASSESSED", "attestation": "external-offline-only",
            "driftScope": "sampled account facts only; no claim of no intervening changes"}


def read_capture(descriptor, parent):
    receipt = parse_json((parent / descriptor["receiptFile"]).read_bytes())
    return {"receipt": receipt, "raw": (parent / descriptor["responseFile"]).read_bytes(),
            "captureLocation": descriptor.get("captureLocation", "BANK/HTTP")}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    generate = sub.add_parser("generate")
    generate.add_argument("--input", type=Path, required=True)
    generate.add_argument("--out", type=Path, required=True, help="new directory, must not exist")
    verify = sub.add_parser("verify")
    verify.add_argument("--fixture", type=Path, required=True)
    verify.add_argument("--input", type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        payload = parse_json(args.input.read_bytes())
        if args.command == "generate":
            fixture = generate_fixture(payload["spec"], read_capture(payload["capture"], args.input.parent))
            # Never open an existing output directory or follow it into an old pack.
            args.out.mkdir(parents=True, exist_ok=False)
            with (args.out / "fixture.json").open("x", encoding="utf-8") as handle:
                handle.write(encoded(fixture))
            print(encoded({"fixture": str(args.out / "fixture.json"), "fixtureSha256": digest(encoded(fixture).encode())}))
            return 0
        fixture = parse_json(args.fixture.read_bytes())
        captures = [None if key == "tool" and payload.get(key) is None else read_capture(payload[key], args.input.parent)
                    for key in ("baseline", "before", "tool", "after")]
        projection = parse_json((args.input.parent / payload["toolProjectionFile"]).read_bytes()) if "toolProjectionFile" in payload else None
        result = verify_fixture(fixture, *captures, payload["expectedBinding"], payload["execution"], projection)
        print(encoded(result), end="")
        return {"PASS": 0, "FAIL": 1, "INDETERMINATE": 2}[result["verdict"]]
    except (OSError, ValueError, TypeError, KeyError, OverflowError) as error:
        print(encoded({"verdict": "FAIL", "reason": str(error)}), end="")
        return 1


if __name__ == "__main__":
    sys.exit(main())
