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

Issue 38 is not closed by accepting empty workspaceFiles. The Java hosts do not
yet provide per-case nonempty workspace mounting; unsupported cases must fail
explicitly. The complete requirements-to-result build facade remains a separate
release gate. Existing approved banking tools do not require arbitrary MCP or
script execution support.

## Single-admin deployment gate

Current stores are process-wide, not tenant-aware. For an explicitly selected
administrator only, FINANCE_EVAL_WORKSPACE_SUBJECT and
FINANCE_EVAL_WORKSPACE_ORIGIN require a server-only ingress credential plus an
exact authenticated gateway subject. All private API reads and writes are gated;
mutations additionally require the configured Origin. This does not provide team
workspaces. The gateway must overwrite identity headers from verified SSO state.
Never populate this configuration using a client-supplied identity or automatically
share the old migration workspace with all logged-in users.

## Verification follow-up

The isolated native probe passed with both history and model snapshots explicitly
enabled, as required by the installed observation asset. It covered four cases
across the two real Java SDKs with a controlled model and synthetic bank, including
wire-level generation parameters, separate sessions/customers, identical installed
method content and owned-build cleanup. No qualification check was removed.
This does not establish live-model quality, nonempty case workspaces or public SSO
acceptance. The migration browser fixture now returns the requested generation
configuration and checks the current candidate-answer label; it remains a fixture,
not native-Runtime or model-wire evidence.
