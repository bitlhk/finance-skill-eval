# Unified migration and Runtime release gates

This checklist supplements the existing migration and Launcher contracts. It does
not introduce a second protocol. HTTP/JSON Launcher remains the integration path.
Only the two managed Java QUERY environments are in scope.

## Formal-entry coverage

Promotion requires both curated and newly uploaded standard Skills. The first
research integration is a sequencing milestone, not a substitute for accepting
the other curated Skills. `packs/finance/curated-online.json` is the versioned
source of the acceptance cohort and cases. At the current baseline it contains:

| Skill | Fixed cases | Source tools requested by those cases |
| --- | ---: | --- |
| auto-insurance-advisor | 3 | get_customer_profile, list_products, get_product_detail |
| investment-research-assistant | 3 | wind_stock_data, wind_financial_docs |
| transfer-risk-review | 4 | account_balance_query, fraud_transfer_risk_assess |
| smart-audit-assistant | 3 | audit_case_context, evaluate_audit_human_review |
| post-loan-risk-control-assistant | 3 | get_post_loan_risk_snapshot, evaluate_post_loan_risk_escalation |
| goldencoach-stage-evaluation | 3 | None; synthetic conversation materials |

This is 19 cases per Runtime, at least 38 executions across OpenJiuwen Java and
AgentScope Java before repeat/fault cases. These are required executions, not a
claim they have passed. Record each Skill/Runtime cell independently. Tool names
above are the original case references, not implicitly admitted installed tools.
Resolve each actual Skill's declarations and the complete Pack dependency closure;
case tool lists are not an installation manifest. Preserve and expose explicit
source-to-installed tool mappings and original/migrated/reference-file digests.
Do not admit all draft Packs merely because their Provider artifact is present.

New-upload acceptance must cover these paths on both managed Java Runtimes:

| Upload path | Required result |
| --- | --- |
| Standard Skill without tool dependencies | Load its real content/references, run the native model, preserve declared limitations; do not add fictitious tool dependencies to claim success |
| Standard Skill using admitted QUERY tools | Check exact dependencies, build and install them, prove tool execution and factual results |
| Skill requiring supported tool migration | Preserve original, analyze, confirm explicit bindings, retain migrated version in the private asset list, select it in evaluation and run both targets |
| Missing/unknown tool, incompatible protocol, unsupported code | Explain the exact missing requirement and managed extension path; block execution, never silently remove tools or score a fabricated answer as success |

Standard format alone does not establish execution eligibility. Uploaded scripts,
arbitrary MCP endpoints and TASK operations remain outside this release boundary.
Reject unsupported inputs explicitly without labeling them business-verified.
Positive upload cases must be freshly imported through the user workflow rather
than supplied only as preinstalled methods or backend fixtures.

For each positive path, verify selection, actual installation, input/method and
model parameter identities, tool facts, missing/unknown handling, result/rubric
visibility and resource cleanup. No-tool cases must not issue business calls.
For migration, independently verify that the migrated asset can be selected later
from the normal test interface. Interface success and business quality are separate
verdicts; preserve partial/failed outcomes. Cross-Runtime consistency means common
inputs, compatible factual conclusions and safety boundaries, not identical prose.

Use synthetic sources and real managed models for final acceptance. Synthetic
MCP results are not live Wind, underwriting, approval or real-funds evidence.
Human professional-quality review remains separately pending unless performed.
Do not switch the root based solely on one accepted Skill or a successful build.

### Frozen holdout coverage in paired Runtime runs

In the ordinary evaluation page, select the same Skill on both managed Java
Runtimes. Packs with frozen holdout files expose an unchecked **包含冻结留出题**
option. Selecting it appends that Pack version's complete holdout set to the
selected development cases on both sides. The catalog exposes only the count
and required tools, not held-out prompts or rubric content. The additional tools
participate in the same environment preflight; unsupported dependencies block
the run. The run configuration and case fingerprint retain the selected scope.

This reuses `includeHoldout` and `holdoutCaseFiles`; it does not generate questions
or introduce a second suite. Missing holdout sets and duplicate case identities
are rejected before Runtime preparation. Dynamic generation remains incompatible
with holdouts. Original-service comparison restrictions are unchanged. Once used
to tune a Skill, a held-out case is no longer evidence of unseen generalization.

`node scripts/verify-holdout-selection-ui.mjs <evidence-directory>` checks the
checkbox, dependency preflight, submitted contract and desktop/mobile layout
against an isolated fixture. It never builds a Runtime or calls a model/bank;
passing it must not be reported as live cohort acceptance. The Runtime comparison
tests separately assert the same frozen cases reach both execution sides.

## Browser delivery workflow

- Export requirements for each target, including the target in the download URL
  and filename; inspect the serialized target rather than trusting the filename.
- Register the first delivery, then register the other without restarting the
  migration. The import control must remain available when pending requirements
  become empty. Refresh and verify both independent bindings and result digests.
- Verify failure or expiration on one side does not replace the other side's
  binding or make either appear business-verified.

## Common evidence chain

For each build and evaluation retain references to the immutable Skill digest,
case suite and file digest, requirement and delivery digests, installed assets and
Lock, Runtime version, actual model and generation parameters, build ID, instance
ID, case/run ID, observation reference and cleanup outcome. Prefer existing fields
and immutable references; do not invent evidence for older records.

Both sides use identical input digests but distinct case workspaces and sessions.
Assert actual tool reads, not merely successful file writes. Include traversal,
symlinks, limits, content drift, cross-case reads, failure, timeout and cancellation.
Cancellation requested and cancellation effective are separate events. Cleanup
must be checked in every terminal path, including incomplete builds.

## Repeatable acceptance

1. Controlled data and model: deterministic assertions on the full flow, isolated
   fault injection and cleanup. Record fixture mode explicitly.
2. Real managed model and synthetic bank: browser upload, analysis/migration,
   two target builds, same cases, tool results, evidence, rubric and cleanup.
   A nonempty answer or successful job status is not sufficient.
3. Identity: every authenticated Linggan account is eligible; no administrator
   allowlist is required. Map the verified SSO subject to its own workspace.
   Two real accounts must each be able to use the service, but neither may read
   the other's private assets, records or downloads. Also reject anonymous or
   spoofed forwarded headers at untrusted ingress. Never use a browser-supplied
   email as authorization, or share the legacy owner's directory with new users.

Both gateway hops must allow synchronous analysis to finish: the current agent
runner total deadline is900 seconds, so the versioned Nginx templates use a950
second read timeout. This is an idle upstream-read budget, not a new model or
execution deadline. Keep the existing body/send limits, authentication and loopback
boundaries. Check deployed candidate fragments as well as these templates; merely
updating repository files does not change a running gateway. An operator override
of the analyzer deadline requires checking every hop again. Do not fix this by
disabling timeouts or retrying the business operation.

`node scripts/verify-inspection-proxy-budget.mjs <new-evidence-directory>` runs
two isolated loopback Nginx hops with scaled timings. Either short hop returns504;
both covering the synthetic backend deadline preserve its409 response. This is
not a real-model, authentication or production traversal test. It stops its own
processes and never reloads the running gateway.

For the existing candidate fragments only,
`python deploy/update-candidate-inspection-budget.py --target origin|gateway`
prints a hash-only plan. Applying requires `--apply --expected-sha256 <plan-hash>`
on the corresponding machine. It preserves headers/routes/send limits, saves a
private backup, verifies Nginx before/after, and reloads. A check/reload failure
restores the old fragment only if the file still equals this operation's output.
Concurrent edits cause refusal. This updates neither application nor root entry.

Report the three results separately. Passing interface tests and native probes
separately does not prove end-to-end completion. Keep Issue #38 open and the PR
unreleased until these gates pass. Preserve existing data and rollback releases.

Automated development verification is not independent human acceptance.

## Fixed synthetic MCP source identity

The bounded reference entry verifies the source/dependency manifest at startup.
It adds `X-Finance-Source-Sha256` to successful and rejected HTTP responses from
that startup identity, never from an uploaded Skill or caller header. Downstream
values cannot override it. Harness v2 source configurations require an exact,
single matching marker before SDK body parsing; mismatches fail closed.

This is a managed deployment consistency check, not authenticated remote
attestation. Process ownership, protected configuration, authority checks and
the current loopback-only boundary remain required. Configuration and source
manifest identities must also be bound to service/Runtime Lock, exact collector
qualification and build-delivery evidence. Marker compatibility tests alone do
not admit a curated Pack or justify switching the public root.
