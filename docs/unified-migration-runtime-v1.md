# Unified migration and managed Runtime evaluation V1

## Baseline and scope

Eval starts at main b7c37b74. Builder starts at finance 26759a1f.
Existing migration, ordinary evaluation, published assets and historical evidence
remain independent and are not rewritten. This change supports the approved
Finance Harness QUERY capabilities on OpenJiuwen Java and AgentScope Java only.
It does not add A2A, a planner, TASK execution, or arbitrary uploaded code execution.

## Responsibilities and transport

Eval owns imported Skill versions, migration candidates, frozen cases, scoring and
comparison. Builder owns managed dependency resolution, compilation, admission,
temporary instances and cleanup. Harness supplies capability contracts, Provider
implementations, execution checks and Runtime integration. Native Runtime drives
the actual tool loop.

Reuse HTTP/JSON Launcher capabilities, instance creation, status, case execution
and deletion. This is execution provisioning, not agent-to-agent delegation; A2A
is not required. Secrets remain server-side. Existing requirements/result contracts
remain the delivery boundary, not a second hand-written tool registry.

## User journey

Upload -> inspect dependencies -> migrate/edit -> freeze candidate -> choose one
or two compatible execution environments -> preflight -> assemble -> execute cases
-> inspect answers and evidence -> reclaim instances. Publishing is not required
for an execution-admitted candidate. Existing Skills can go directly to evaluation.

Migration correctness and cross-Runtime portability are separate experiments.
Cross-Runtime comparison must bind the same candidate digest on both sides and
evaluate both sides against case requirements; agreement alone is not correctness.
Ordinary lightweight evaluation remains available and does not require compilation.

## Admission and lifecycle

Only dependencies resolvable to managed QUERY capabilities may be installed.
Uploaded scripts/MCP dependencies are rejected when unsupported, not discarded.
Scope declarations never grant banking authority. Runtime, model, connection,
Provider and observation qualification retain their existing admission checks.

Compile once per selected Runtime and frozen configuration, not once per case.
Any cache requires exact version and configuration identity. Each case uses an
isolated session; preserve stronger existing host restart isolation initially.
Completion, cancellation, timeout and partial launch failure trigger cleanup.
The shared Launcher stays running. Store evidence and Locks independently from
temporary processes and disposable build output. TTL remains a fallback, not the
only cleanup mechanism.

## Release gates

- Actual request compatibility across both repositories, including workspaceFiles.
- Runtime type and delivery resolution agree between UI and execution admission.
- Same candidate digest and actual generation parameters are observable on both sides.
- Imported draft -> migration -> two native builds -> case execution -> cleanup.
- Missing tools, stale delivery, unsupported execution and owner violations fail closed.
- Root entry preserves existing ordinary evaluation and private migration authority.
- Public browser verification follows actual login; a local proxy check is not equivalent.
- No release until native and browser gates pass; no claim of human independent acceptance.

## Current implementation boundaries

The candidate adds CC (same-candidate cross-Runtime comparison), separate goal
assessments for each side, explicit AgentScope registrations and preservation of
requested generation parameters. BC remains a single-candidate assessment; it is
not renamed into a two-Runtime experiment. Legacy runtime_http registration files
are retained but not offered as new Launcher execution environments.

A delivery must retain its accepted requirementsDigest and match the registered
deployment and expiry. Old bindings lacking this digest require re-admission.
Projects retain accepted deliveries by environment ID so admitting a second Runtime
does not overwrite the first. The legacy `runtimeDelivery` field remains the latest
binding for older readers. Execution checks each selected environment against its
own requirements and accepted delivery; one target cannot satisfy another's gap.
Both requirements endpoints (JSON and YAML) accept `runtimeType=openjiuwen` or
`runtimeType=agentscope`, defaulting to OpenJiuwen for existing callers. Unknown
targets are rejected. This is delivery binding, not implementation of the Builder
requirements-to-result facade.
Technical validation of generated tools has its own requirements gate and is not
bypassed by the comparison feature.

The two Java hosts now mount nonempty case files in isolated, bounded workspaces
and expose the admitted read_case_file tool. Builder's requirements-to-result
facade performs a real build and installation before returning a delivery.
Eval then runs its own lifecycle admission using the actual candidate Skill.
These implementations do not close Issue 38 without the remaining release gates.
Existing approved banking tools do not require arbitrary MCP or script execution.

The native binding path reuses operator-admitted tool contracts instead of
generating MCP wrappers for existing tools. The source diagnosis, every declared
tool, target catalog, input/output contract and constraints must agree. A missing
implementation is not accepted by name alone. The candidate freezes the source
digest and target contracts in references/finance-native-bindings.txt; this is a
JSON-text reference, not executable code and not a formal publication.

The prebuilt native-readonly-balance 1.0.3 sample has an explicit optional account
selector contract and one fixed synthetic balance/file case. It does not make the
other featured Wind, insurance or lending dependencies automatically available.
Unsupported tools continue to block native evaluation with a missing-tool list.

## Single-admin deployment gate

Current stores are process-wide, not tenant-aware. For an explicitly selected
administrator only, FINANCE_EVAL_WORKSPACE_SUBJECT and
FINANCE_EVAL_WORKSPACE_ORIGIN require a server-only ingress credential plus an
exact authenticated gateway subject. All private API reads and writes are gated;
mutations additionally require the configured Origin. This does not provide team
workspaces. The gateway must overwrite identity headers from verified SSO state.
Never populate this configuration using a client-supplied identity or automatically
share the old migration workspace with all logged-in users.

## Initial verification follow-up (historical)

The isolated native probe passed with both history and model snapshots explicitly
enabled, as required by the installed observation asset. It covered four cases
across the two real Java SDKs with a controlled model and synthetic bank, including
wire-level generation parameters, separate sessions/customers, identical installed
method content and owned-build cleanup. No qualification check was removed.
This does not establish live-model quality, nonempty case workspaces or public SSO
acceptance. The migration browser fixture now returns the requested generation
configuration and checks the current candidate-answer label; it remains a fixture,
not native-Runtime or model-wire evidence.

## 2026-10-01 final closeout verification

Runtime code: Eval 10d0ff84, Builder 2a17c78d, Harness db8e79cf. The Eval local
suite passed 416 tests and type checking; Builder passed 1908 tests with five
explicit skips. Fresh packaged-host qualification and controlled native delivery
were rerun. These are candidate revisions, not deployed or merged versions.

The latest evidence is kept under the operator's
`outputs/eval-unified-migration-runtime-v1` directory:

| Path | Scope and outcome |
| --- | --- |
| `case-live-browser-r2` | Uploaded supported read-only Skill: real model, four native executions, facts/files/Lock/history/cleanup passed. |
| `prebuilt-live-r5` | Immutable sample 1.0.3: both native runtimes passed the fixed synthetic case through the browser. |
| `migration-native-live-r12` | Same 1.0.3 source uploaded, analyzed, explicitly bound to both targets, migrated to an immutable temporary candidate, four real-model case executions and cleanup passed. No formal publication required. |
| `candidate-delivery-live-r2` | Pinned staged release: both real builds SUCCEEDED and Eval lifecycle admission PASSED; owned instances reclaimed. |
| `unified-candidate-ingress-20261001-unified-10d0ff84.json` | 18 trusted-ingress checks passed. This is NOT an actual SSO login. |

The sample digest is
`db573f2d2339caffeee32023440eacd853a075d28afd4b78f284eaad0a73943f`.
The original upload and migrated candidate retain distinct digests; both Runtime
targets install the same candidate within each comparison. Wire evidence records
the real model, generation parameters and tool definitions. Test fixtures use
synthetic banking data, not real customer accounts or funds. Professional answer
quality and independent human use remain unassessed.

Failures are retained: prebuilt r4 supplied an invalid model-generated `input`
wrapper; migration r11 inferred an injection contract from Host authorization
prose. The versioned sample clarifies direct tool arguments, and the analyzer now
distinguishes referenced managed tools from migrating their implementation.
Explicit runtime dependencies still block native binding. This does not guarantee
all future model outputs or dependency analyses are correct.

After an unverified execution failure, later cases on that Runtime are recorded as
NOT_EXECUTED and are not quality-scored; no implicit replay or new instance is
created. Host failures retain only allowlisted error classes. Background migration
diagnostics are awaited on service close so test/data cleanup cannot race a final
write.

Release `20261001-unified-10d0ff84` is staged only. Real administrator SSO login,
second-account browser denial, final data synchronization and public cutover are
still required. Existing production services, data and Locks remain unchanged.
Do not close Issue 38 or represent these isolated browser checks as public
end-to-end acceptance.

## Earlier 2026-10-01 candidate verification (historical)

At Eval 0d9f5522, the complete suite passed 413 tests. Builder 5a094856 includes
the latest finance branch and passed 266 final targeted tests; its prior full
run passed 1896 tests with five explicit skips. Harness remains db8e79cf.
All three revisions are candidates, not a claim that upstream merged them.

The fixed prebuilt sample passed both native Java runtimes with a real model,
synthetic facts, file content, installed versions and cleanup checked. Uploaded
supported read-only Skill and actual Builder delivery/lifecycle admission also
have separate successful evidence. Those runs are not combined into a fictitious
single successful migration run.

Real migration diagnosis, explicit binding, candidate import and dual execution
were exercised. Runs r7-r9 exposed model-generated invalid optional arguments
(including an empty accountId or an extra input wrapper), and did not pass the
all-cases-completed acceptance. The rejected calls and cleanup remain evidence;
no authorization, contract, qualification or scoring gate was disabled. A terminal
Launcher failure now retains its normalized failure code instead of always being
reported as missing SSE evidence. This is not a claim of stable answer quality.

An independent release at 20261001-unified-0d9f5522 combines copies of the previous
private Eval and migration data without overwriting collisions. Old immutable
methods remain intact; the new Launcher uses a separately verified current-
directory method anchor. Trusted-ingress permission checks passed 18 checks and
the root UI passed desktop/390px checks. This simulates the trusted upstream hop,
not an actual SSO login. Real administrator login and public cutover remain open.
Candidate evidence lives in outputs/eval-unified-migration-runtime-v1 on the
operator host. See STATUS.md there for the latest outcome and preserved failures.
