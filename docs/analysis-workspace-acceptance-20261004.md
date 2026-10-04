# Analysis workspace boundary and first live inspection

Candidate only. This extends Eval6dffb39 without changing Builder7398595b or
Harness8f2c6a0. All authenticated Linggan accounts remain the intended users;
there is no administrator allowlist. Production was not changed.

## Boundary found and repaired

Account API isolation is insufficient if an analysis model can ask its file
tools to read arbitrary paths. The existing A2 shell-registration restriction
did not scope the SDK read, glob and directory-list tools to the temporary
source workspace. An actual SDK probe read a synthetic sibling marker and
listed its filename. This did not access production data or demonstrate an
actual cross-account incident.

A2 now delegates to the same pinned SDK file tools only after checking the
resolved workspace boundary. Relative paths are rooted there; omitted list/glob
paths cannot use the process directory. Escaping glob patterns and symlinks or
special files in the source tree are rejected. Scanner/grep skip linked or
out-of-root files. Single-file grep now passes a file/content pair instead of
attempting to unpack a Path. A4 and native Java execution are not extended.

The filesystem restriction assumes an isolated, read-only analysis workspace.
It is not a sandbox against another privileged process swapping files during
an invocation. Uploaded archives cannot create links; uploaded code is not run.

## Reproduction

Use the existing interpreter from `integrations/openjiuwen/pyproject.toml`,
OpenJiuwen Python0.1.17.post1. No SDK changes or upgrades are required.

```sh
python -m unittest tests.test_analysis_file_boundary tests.test_analysis_workspace_text
python scripts/verify-analysis-file-boundary.py --output /tmp/analysis-boundary-guarded.json
python scripts/verify-analysis-file-boundary.py --legacy --output /tmp/analysis-boundary-legacy.json
```

Use new output filenames; evidence is not overwritten. Both probes create their
own synthetic source/sibling directories and remove them afterwards. Legacy
PASS means the old behavior was reproduced, not that its boundary is acceptable.
Run with a private temporary directory if the SDK's shared local file lock is
unavailable. Do not delete another process's locks to make the probe pass.

Nine boundary tests plus three text-workspace tests passed. Full Eval regression
passed527/527 after allowing its local HTTP fixtures; the initial restricted
sandbox run failed498/527, including `listen EPERM` and subprocess failures.
That failed report is retained, not relabeled successful. TypeScript checks and
the full build pass (existing Vite chunk-size warning). The portable guarded
probe above was also rerun successfully with actual SDK I/O.

Original evidence under the release evidence directory:

| File | SHA256 |
| --- | --- |
| analysis-path-before.json | 8479af5b7a9e4d8840b546e214ddf38877873151a6f26b1ac93a48e211a2ed25 |
| analysis-path-after.json | 686f948e1ed536d243e009b9a90e9fb40e694035726c180d91ee78a04f3c4142 |

After the fix all three outside-workspace operations fail before SDK I/O, while
all three own-workspace operations still succeed. The controlled unit tests
also check traversal, brace patterns, symlinks and preservation of read options.

## Limited real-model inspection

`scripts/verify-native-live-analysis.mjs` exercises actual upload, project
creation and inspection APIs with the genuine A2 analyzer. It requires explicit
approval, a bounded readonly archive and configured model access. It disables
code generation and performs no native Agent or bank execution.

The approved transfer-risk readonly method archive had digest
`a08940661b8a7a6f78f13ac0f6fec979c5d8bef07d9d3fcf63b6c44bd9aa344f`.
One run produced a COMPLETE dependency analysis with located evidence for
exactly `curated_account_balance_query` and `curated_fraud_transfer_risk_assess`.
This is method/tool-reference recognition, not successful migration or proof
that an inferred dependency is executable. Professional quality was not scored.

The relay forwarded four real requests with temperature0.2, max_tokens32000
and stream=false, and saved four public responses. It also rejected two attempts
as MODEL_OR_PARAMETERS_MISMATCH. Those rejected bodies were not retained, so
the differing fields and reason cannot be inferred. This is not a clean model
parameter gate. Responses also used two distinct model aliases:
`deepseek-v4-flash-ga-260731` and `deepseek-v4-flash-0731`; equivalence is unproven.
No hidden reasoning content or real key is included in retained wire evidence.

| File under approved-native-analysis-r1 | SHA256 |
| --- | --- |
| analysis/report.json | e3dd8f83008d9673fc2d7fe25726db044b95421b627440557b4aa57337a8510c |
| wire.json | 8a5dc573414203c63cbab06957ea7d36acc0daeaaa78608acc772c98791a4a29 |

The narrow analysis report's PASS does not override the wire discrepancies.
Real SSO, reviewed release configuration, live migration/native browser closure
and remaining case/quality gates are separate. No merge or formal-entry switch
is authorized merely by this report.

## Follow-up: text-only SDK model traffic

The actual A2 subprocess was exercised against a local synthetic HTTP model.
Before the fix, it sent two image probe requests with temperature0/max_tokens32
alongside two expected text requests with temperature0.2/max_tokens32000.
This reproduces the unexpected request shape without external model calls; the
previous live rejected bodies remain unavailable, so they are not retroactively
reclassified. SDK `DeepAgent._resolve_read_image_multimodal` schedules this probe
when its public `enable_read_image_multimodal` configuration is unset.

A2 now explicitly disables image attachment/probing through that existing SDK
configuration and the read tool option. It remains text/source-code analysis;
image contents are not interpreted as migration evidence. No SDK source changed.
`tests.test_analysis_model_wire` runs the actual subprocess, checks its produced
result and every captured HTTP request, and passes with the other12 Python tests.
Before/after logs are `analysis-image-wire-before.log` and
`analysis-image-wire-after.log` in the release evidence directory.

The existing curated native browser verifier has an opt-in
`CURATED_UI_LIVE_ANALYSIS=true` mode, requiring explicit transfer approval and a
configured analyzer model. It invokes the real analyzer during page upload,
retains analysis/inspection evidence and requires located tool references before
the existing binding, candidate generation and dual-Runtime workflow. Default
controlled verification is unchanged. The mode alone is not acceptance evidence;
Judge quality and real SSO remain separately labeled.
