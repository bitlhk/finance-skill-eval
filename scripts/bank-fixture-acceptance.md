# Offline Synthetic Bank Fixture Acceptance

Only local files are read. No service configuration, network, deployment, product
case/Judge contract changes, or automatic publication. Python 3.10+ standard
library. The CLI generates only `fixture.json`; it never creates a Skill or pack.

## Generate

Create an input JSON using independently captured files (relative paths resolve
against this input file; absolute paths also work):

```json
{
  "spec": {
    "fixtureId": "synthetic-accounts-observed-v2",
    "version": "1.0.4",
    "syntheticOnly": true,
    "scope": {
      "mode": "all",
      "authorizedAccountIds": ["acct-001", "acct-002", "acct-class-ii-001", "acct-class-iii-001", "acct-usd-001"],
      "accountIds": ["acct-001", "acct-002", "acct-class-ii-001", "acct-class-iii-001", "acct-usd-001"]
    }
  },
  "capture": {
    "responseFile": "/home/ubuntu/outputs/eval-curated-closeout-v3/fixture-before-r1/accounts.json",
    "receiptFile": "/home/ubuntu/outputs/eval-curated-closeout-v3/fixture-before-r1/receipt.json"
  }
}
```

The authorized set must be independently approved, not inferred from a model
answer. For a specified-account case use `mode: "specified"` and select only the
required `accountIds`; all returned accounts still participate in drift checks.

```sh
python3 scripts/bank_fixture_acceptance.py generate --input generation.json --out /tmp/bank-fixture-v2-new
```

The output directory must not exist (including symlinks). Versions at or below
1.0.3 are rejected. Output includes `fixtureSha256`: SHA-256 of the generated
canonical fixture JSON bytes, distinct from the original HTTP body's SHA-256.
Retain original response and receipt files for later replay. Do not reserialize
the original response: its exact bytes are pinned to the receipt.

## Verify

```sh
python3 scripts/bank_fixture_acceptance.py verify --fixture /tmp/bank-fixture-v2-new/fixture.json --input acceptance.json
```

`acceptance.json` is an external sidecar, NOT a product case or Judge contract:

```json
{
  "baseline": {"responseFile": "baseline/accounts.json", "receiptFile": "baseline/receipt.json"},
  "before": {"responseFile": "before/accounts.json", "receiptFile": "before/receipt.json"},
  "tool": {"responseFile": "tool/accounts.json", "receiptFile": "tool/receipt.json"},
  "after": {"responseFile": "after/accounts.json", "receiptFile": "after/receipt.json"},
  "expectedBinding": {
    "fixtureSha256": "<generate output fixtureSha256>",
    "runId": "<authorized run>",
    "side": "right",
    "caseId": "<new case ID>",
    "toolRequestId": "<current tool response requestId>",
    "fileMarker": "<independently chosen case.txt marker>"
  },
  "execution": {
    "binding": {
      "fixtureSha256": "<generate output fixtureSha256>",
      "runId": "<authorized run>",
      "side": "right",
      "caseId": "<new case ID>",
      "toolRequestId": "<current tool response requestId>",
      "fileMarker": "<independently chosen case.txt marker>"
    },
    "status": "completed",
    "streamCompleted": true,
    "runtimeIdentityVerified": true,
    "traceComplete": true,
    "error": null,
    "attempts": [
      {"name": "account_balance_query", "status": "completed", "sideEffect": "read", "requestId": "<current tool response requestId>"},
      {"name": "read_case_file", "status": "completed", "sideEffect": "read"}
    ],
    "output": "<original complete model answer, a JSON string as described below>"
  }
}
```

`baseline` is the capture used to generate the fixture. It may also serve as
`before` when it is the actual immediately preceding independent capture.
`tool` must be the current received bank result captured by a trusted collector,
not a model-created reconstruction or a substituted pre-read. Before/tool/after
request IDs must differ; capture times must be ordered. The expected run binding
comes from the authorized caller, execution binding/attempts from the trusted
execution trace. Do not manufacture `traceComplete`, identity or side-effect
evidence from the final answer or a job's `completed` status. Missing evidence
fails closed. Earlier failed attempts must remain in the trace.

### Answer Assertion Format

`execution.output` must contain exactly one JSON object, without code fences or
surrounding prose. Example for a **specified acct-001** fixture only:

```json
{
  "sourceSystem": "account-core-simulator",
  "asOf": "<asOf from this run's tool response, not baseline time>",
  "accounts": [
    {"accountId": "acct-001", "currency": "CNY", "availableBalance": "128650.32"}
  ],
  "fileMarker": "<case.txt marker>"
}
```

An all-account fixture requires all selected accounts exactly once. Order and
decimal trailing zeros do not matter; account/currency/amount tuples do. No
other answer keys are accepted. Money is parsed as exact decimal, never float.
Zero is a present fact, not missing data. Wrong/extra/missing account, amount,
currency, source, marker, or current response timestamp fails.

## Receipt And Evidence Limits

- Supports current `data.accounts`, legacy `data: [...]`, and single AccountView
  detail data. Rejects stale, failed, empty, redacted and paginated responses.
- Requires receipt `syntheticOnly: true`, `basis:
  INDEPENDENT_AUTHORIZED_READ_NOT_MODEL_OUTPUT`, `capturedAt`, `subjectRef`,
  `route`, `rawResponseSha256`, `sourceSystem`, `sourceAsOf`, explicit
  `databaseSnapshotVersion` (null is valid), and `businessWriteCalls: 0`.
  Optional receipt `requestId`, when present, must match the raw response.
- The entire original receipt, including unrecognized and null fields, is
  retained unchanged in the fixture. Original response bytes remain in the
  input file; SHA-256 covers all bytes including fields outside the fact scope.
- `baseline.observationSnapshot.factsSha256` is a canonical **observed fact**
  digest with basis `INDEPENDENT_CAPTURE_FACTS_NOT_DB_ATTESTATION`. It does not
  replace or invent `databaseSnapshotVersion`, which remains null if unknown.
- Data identity uses receipt subject/route/policy and optional capture provenance.
  Unknown purpose/parameters/build/seed/connection/configuration values remain
  null. Known values are compared across captures. Unknown is not proof of equal
  hidden configuration. No runtimeHostLock, Skill, case or workspace digest is
  needed for data generation; runtime/run binding is supplied later.
- Drift checks cover all returned account IDs, currencies, available/ledger
  balances, supplied account record timestamps/versions/status, source, and
  declared capture identity. Missing ledger balance is explicitly recorded;
  available balance and currency are mandatory. Root `asOf` is format-checked,
  not pinned across captures. `recentTransactions` and other non-account fields
  are not transaction-ledger drift checks.
- Equal before/tool/after observations do **not** prove there were no intervening
  changes (including change-and-restore), that the database itself is correct,
  or that caller-supplied receipts/traces are authentic. This is offline external
  consistency acceptance, not cryptographic or product-native attestation.
- Facts and execution are reported separately. Either failure gives exit code 1;
  both passing gives 0. Judge stays `NOT_ASSESSED`. Check each side separately;
  one side's PASS never promotes the other side or a historical failed run.

## API And Tests

Import `scripts.bank_fixture_acceptance` from the repository root:

```python
from scripts.bank_fixture_acceptance import generate_fixture, generate_case, verify_fixture

# capture = {"raw": original_response_bytes, "receipt": parsed_independent_receipt}
fixture = generate_fixture(spec, capture)
# Optional draft only, using the unchanged existing case fields; no file writes:
case = generate_case(fixture, "NEW-CASE-ID", "NEW_FILE_MARKER")
result = verify_fixture(fixture, baseline, before, tool, after, expected_binding, execution)
```

`generate_fixture` accepts no answer or run information. `generate_case` is an
optional in-memory helper; publication and Skill/pack versioning remain with the
caller. Its rubric is advisory; external structured checks are required.

```sh
python3 -m unittest discover -s tests -p test_bank_fixture_acceptance.py -v
```
