# Fact provenance and evidence, V2

Existing reports are immutable. `fact-provenance-v2` is a new judging policy, not a
rewrite of prior PASS/FAIL results. New goal assessments resolve the exact Skill
artifact and provide its instructions to the judge. The extra source-boundary
criterion is separately labelled; it does not require bank facts to originate in
user input when the Skill permits tool sources. Additional rubric requirements
remain rubric requirements, not retroactive Skill obligations.

Unknown token totals are null, including partial accounting. Disabled tool-body
collection is not evidence of no calls. Per-case archive status is an execution
snapshot, not final archival state. New reports include the server checkout SHA
and whether it was dirty; old reports remain unlabelled when the version is unknown.

Launcher DELETE remains compatible with old acknowledgements. A new optional
cleanup observation records its time, instance and optional public build identifiers,
managed-resource release status and limits of observation. Its schema is
`contracts/runtime-launcher/finance.eval-cleanup-observation.v1.schema.json`.
Eval polls boundedly, then records PENDING
or UNKNOWN rather than inferring full cleanup. Reports capture that observation
after cleanup, before calculating the report fingerprint. This does not prove
absence of every OS process, nor independently verify temporary-candidate cleanup.

Compare same Skill digest, input, model parameters and business date. Preserve
original samples and scores; record execution completion, automatic quality and
human review separately. New login, live second-account isolation, executing-stage
cancellation and full resource reclamation need their own acceptance evidence.

## Current policy: fact-provenance-v4

The bank-admitted Launcher and package Launcher share one server-owned
`resultEvidence` policy. The default `digests` sends tool identity/status/digests,
not result bodies. An operator may explicitly opt into `redacted_results` only
for data authorized for Eval storage and its configured Judge. This is not a
client-selectable setting and does not grant additional tool permissions.

`metadata.toolEvidence` contains actual observed tool results, not facts extracted
from the final answer. `result` is bounded JSON text marked
`resultCapture: REDACTED_PROJECTION`; credential/hidden-reasoning fields are removed,
support-tool contents are excluded, and omitted results retain `resultOmitted`.
Bodies are limited to 8 KiB per result and 64 KiB per case (including JSON string
encoding). The policy does not anonymize every business identifier; the operator
must authorize the remaining data. Authorization receipts, host sessions and
native event payloads are not forwarded as business source facts.

`toolEvidenceCollection` distinguishes DISABLED, PARTIAL and CAPTURED and records
captured/omitted counts with scope OBSERVED_BUSINESS_TOOL_RESULTS. CAPTURED is not
proof of all framework calls or all fields; `completeFieldCoverage` remains false.
Digests cannot establish values; failed calls cannot establish successful results.
Unknown/redacted facts remain INDETERMINATE, never automatic PASS.

Tool data timestamps (`asOf`, snapshot/update time) are independent of the Host
business clock unless the task/contract explicitly requires equality. A Skill's
requirement to display *returned* information does not authorize inventing fields
the tool never returns. Explicit task/rubric requirements still apply. Historical
reports are not rewritten by this policy change.

Goal Judge requests include a neutral response template for every required index,
including the Skill source-boundary criterion. No template preselects PASS.
The existing two-attempt correction bound and strict coverage/quote validation
remain: a model that still omits a criterion is unavailable, not automatically
passed or repaired by inventing a verdict. Frozen cohorts also pin source hashes;
previous attempts are retained and never replaced by a later passing run.
