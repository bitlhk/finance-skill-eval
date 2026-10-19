# Runtime Launcher v1 contract

Capabilities may optionally include `executionEnvironment.software`, a bounded
list of public `{name, version}` facts measured by the Launcher in its actual
execution environment. Omission means unknown, not incompatible. This additive
v1 field is included in the frozen capabilities digest; each selected deployment
is checked independently. Never put paths, credentials or customer data here.
These facts support deployment prerequisite checks at check-Judge level, not
business case verdicts. A worker interpreter version does not attest a different
interpreter selected by `uv`, containers, MCP or remote services; those require
their own actual observations. Do not substitute Skill dependency declarations
or the control server's interpreter for measured execution facts.

This directory is the portable contract for Runtime Launchers returned by an external Runtime Builder. A Launcher implementation is framework-neutral at this boundary: it translates framework-native lifecycle callbacks into stable Finance Runtime events and may attach a sanitized native extension.

An instance's optional `skill.skillFile` names the document relative to the full
archive; omission means `SKILL.md`. A compound Skill/MCP bundle may use
`skill/SKILL.md` without moving sibling projects. Validate the safe entrypoint and
its equality with `instructions`; supplied `files` must use actual archive paths
and matching content, not document-relative aliases. Resolve document references
from its directory, but executable launch paths from the archive root. Existing
root packages omit this additive v1 field. Nested-entrypoint senders and receivers
must be deployed together; unsupported receivers must reject rather than guess.

## Lifecycle and availability

### Cleanup observations

DELETE may return `{ "deleted": true, "cleanup": <observation> }` using
[`finance.eval-cleanup-observation.v1.schema.json`](finance.eval-cleanup-observation.v1.schema.json).
`deleted` acknowledges cancellation/deletion intent, not completed release. `PENDING`
means preparation, execution or retirement is still active; `FAILED` means cleanup
failed and can be retried. `RELEASED` observes only this Launcher's managed resources
(`LAUNCHER_MANAGED_RESOURCES`, or legacy `THIS_INSTANCE`), not a global OS audit or
a business verdict. Retained diagnostic evidence is outside this disposable scope.
Never return secrets, paths or raw error details in a receipt. Eval discards unknown
fields, requires a matching instance ID, limits responses to 64 KiB and polls at
most ten times. No valid receipt (including an old acknowledgement or 404) is
`UNKNOWN`, never inferred success. Cleanup errors do not change business scores.

Capabilities are discovery, not admission by declaration. A configured target
whose native qualification is missing or stale must fail preflight with a safe,
actionable error, not advertise readiness or silently switch frameworks. Instance
creation still independently enforces the current admission gates.
Eval allows at most 60 seconds for capabilities and native-catalog probes, since
native qualification may require a bounded subprocess plus artifact validation.
This is separate from instance execution and deletion timeouts.

## Builder delivery descriptor

After deployment, the Builder returns a `finance.runtime-launcher-descriptor.v1` document. It identifies one deployed Launcher by `deploymentId` and `artifactSha256`, provides its `baseUrl`, declares the supported protocol versions and states whether the caller must supply a bearer credential. The descriptor never contains a token, API key, model credential or MCP secret.

The descriptor deliberately does not copy models, default model, MCP support, resource limits or observation detail. Those values are discovered from `GET /v1/runtime-capabilities`, then verified against `capabilitiesDigest` using RFC 8785 canonical JSON and SHA-256. The descriptor's Runtime type and version must also match the capabilities response. A Builder delivery is accepted only when these checks pass and `observability` is declared.

`artifactSha256` is the immutable provenance identity of the built Launcher. It does not require this service to download or execute a package. `expiresAt=null` means the deployment has no Builder-declared expiry; it does not disable per-instance TTL cleanup.

Authentication material is provisioned outside this JSON. `authentication.type=bearer` only declares the scheme and optional audience so the receiving environment can resolve a credential through its own secret store.

## Fixed HTTP surface

- `GET /v1/runtime-capabilities` returns `finance.skill-eval.runtime-capabilities.v1`.
- `POST /v1/runtime-instances` creates an isolated instance and requires an `idempotency-key` header.
- `GET /v1/runtime-instances/{instanceId}` returns its current state.
- `POST /v1/runtime-instances/{instanceId}/execute` executes one stateless case and returns final evidence as JSON or an SSE stream whose terminal item contains that evidence.
- `DELETE /v1/runtime-instances/{instanceId}` releases the instance. The Launcher must also enforce its advertised expiry.

Remote Launchers must use HTTPS. Returned execution endpoints must remain under the registered Launcher's origin and base path. Responses, events and evidence must never expose credentials or secret configuration values.

## Existing native capability reuse

`nativeToolNames` is discovery only. The optional v1 `nativeCapabilities` array advertises
`capabilityId`, callable `name`, `contract` (input/output/error JSON Schemas and semantics), and
`constraints` (permissions, side effects, isolation). IDs and names must be unique; each name must
also appear in `nativeToolNames`. Advertise implemented behavior only, not planned support.
Descriptions must not contain secrets, host paths, or imply OS sandboxing where none exists.

Eval gives this online inventory to diagnosis when the user selects an existing Runtime. Source
requirements remain recorded. Exact contract and constraint matching can authorize reuse for
testing without fabricating a Builder Result. Names alone, unknown contracts, different semantics,
or an explicit rebuild are insufficient. A matching declaration is not a contract-test or business
verdict; actual execution and frozen business evaluation still follow. Eval pins the discovery
digest and rechecks it before a new evaluation or candidate adoption; changes require a new check.

This is an additive field in the current v1 contract. Older Launchers without it still work but
cannot prove reuse from names alone. Strict older clients can reject the new field: deploy the Eval
schema update before enabling the updated Launcher. No registration v2 is introduced.

## Observability boundary

The stable `kind` in `finance.runtime-observation.v1` describes cross-framework semantics, not a framework callback name. `source.nativeEventType` records the original callback name when one exists. `source.synthesized=true` means the Launcher inferred the event from a boundary it controls. Optional `native.data` is diagnostic-only: it must be JSON and must not contain credentials, authorization material, cookies, raw chain-of-thought, hidden reasoning, raw business request/response bodies, or model prompts.

Observation limits are executable receiver requirements, not documentation hints. Eval rejects an event above 65,536 serialized UTF-8 bytes, `native.data` above 32,768 bytes or eight levels deep, identifiers above 200 characters, messages above 4,096 characters, output deltas above 16,384 characters, and native objects whose property names indicate secrets or hidden reasoning. The JSON Schema carries the portable length rules plus `x-maxSerializedBytes`, `x-maxDepth`, and `x-forbiddenPropertyNames`; receivers must enforce those annotations. A rejected observation terminates that execution stream instead of being persisted or displayed.

The SSE transport is bounded while bytes are being read: an unfinished or complete frame above 524,288 bytes is cancelled before JSON parsing, and a stream ending with a non-empty unfinished frame is rejected. Terminal evidence has its own 262,144-byte serialized limit, plus the field and collection limits published in `finance.skill-eval.runtime-evidence.v1.schema.json`. These limits also apply when evidence is returned as plain JSON.

Builder verification records are self-reported build evidence. They do not make a deployment usable. Eval records a separate `evalConformance.status=PASSED` only after it has independently exercised capabilities, create, status, execute, terminal evidence validation, and delete against the admitted Launcher target.

Launcher capabilities may advertise an `observability` object:

- `core` requires execution start, completion and failure events.
- `tool` additionally requires model-call and tool-call start, completion and failure events.
- `detailed` has the same normalized minimum as `tool` and also carries sanitized native event extensions.

Profiles are minimum guarantees. `supportedKinds` is the exact set a Launcher may emit and must include the minimum for its profile. Absence of `observability` identifies a legacy Launcher and must not be interpreted as Tool-level visibility. Builder-delivered Launchers must declare it.

Acceptance may depend only on final execution evidence and the `core` guarantee. Missing optional events cannot fail migration acceptance. Optimization and diagnostics may use richer events only after recording the declared profile. Neither normalized nor native events may contain hidden chain-of-thought, credentials, authorization headers or unredacted sensitive business values.

Framework-specific consumers must use `native` data explicitly. Portable consumers must ignore it and use only normalized fields.

## Files

### Optional MCP result-channel observations (additive v1)

`features.mcpResultChannels: true` advertises comparison of the actual MCP
`tools/call` response text JSON and `structuredContent`. Each completed MCP call
may put `mcpResultChannels` in its corresponding `metadata.toolEvidence` entry,
following `finance.runtime-mcp-result-channels.v1.schema.json`. The entry must
correlate with the successful tool call's ordinal and name. `MATCH` means equal
canonical JSON SHA-256 digests; `MISMATCH` means unequal digests. Receivers must
enforce this cross-field relation in addition to the JSON Schema. `UNAVAILABLE`
has no digests: either channel was missing, non-JSON, too large, or unsuitable
for comparison. Never include raw channel bodies or credentials in the receipt.

Eval exposes only valid receipts from completed, identity-verified, finished
executions. Omitted/invalid receipts remain unknown; source code, a result
projection or a model's assertion cannot replace actual channel observations.
These are authenticated Launcher assertions about those calls, not proof of
business correctness, all unobserved calls, or internal memory behavior. Ordinary
business evaluation does not require this optional extension. A reuse promise
explicitly requiring channel consistency needs actual comparable observations.

`features.mcpPrepare: true` separately advertises support for the Launcher's
bounded prepare contract. It does not authorize arbitrary shell execution or
guarantee any specific package is installed. Both flags must be probed from the
actual deployed worker; an older worker cannot inherit flags from its host's
source tree. Update strict receiver schemas before enabling these v1 additions.

### Optional Script process observations (additive v1)

`features.toolProcessEvidence: true` advertises actual subprocess start/exit
observations for Launcher-managed Script calls. Terminal
`metadata.toolProcessEvidence` follows
`finance.runtime-tool-process-evidence.v1.schema.json`. Omission means unknown,
not evidence that a process was independent. The extension is optional for
ordinary business evaluation; a reuse requirement explicitly promising process
lifecycle needs this evidence or another independently verified observation.

Each record's `callIndex` references the same zero-based entry in `toolCalls` and
`metadata.toolEvidence`; tool name, completed status, argument/result digests and
case scope must agree. Emit only after the actual child has exited with code zero.
Use a fresh opaque process-scope ID per created process, never an OS PID, executable
path, environment, command line or raw input/output. Start must precede exit.
Eval treats invalid correlations as INVALID, not positive lifecycle evidence.
These are authenticated Launcher assertions about its managed Script processes,
not independent OS sandbox attestation, global resource release or an audit of
internal memory. Static source and business no-cross-talk tests remain separate.
MCP/remote/native tools must not acquire fabricated Script-process receipts.

This extends the existing terminal evidence metadata, without imposing framework
callback names or introducing registration v2. Strict clients must be upgraded
before the optional capabilities flag is enabled.

### Native multi-turn execution (additive v1)

`features.multiTurn: true` advertises distinct native Agent calls with preserved session,
workspace and MCP lifecycle **inside one case**. Omission/false means unsupported.
`runtime-case.turns` contains 2–8 `{query, requiredTools}` entries. The root `query` is
the evaluation objective, not a concatenated conversation; root `requiredTools`
includes every per-turn requirement. Independent cases remain isolated.

Terminal `metadata.caseScopeId` identifies a native case scope. Multi-turn evidence
includes `metadata.conversation = {sessionId, workspaceId, turns}`. Each completed
turn records zero-based `index`, canonical SHA-256 `queryDigest` and `outputDigest`,
redacted `output`, `status: completed`, and completed `toolNames`. Completed case
output is the turn outputs joined as `Turn N:\n<output>`, separated by blank lines.
Failure may retain a verified completed prefix; it cannot count as acceptance passed.
For a completed case, flattened per-turn `toolNames` must match all completed
`toolCalls` by name and count, including repetitions; missing or extra calls invalidate
the receipt. Failed cases may have an unreceipted tail from the failed turn.
Receipts and IDs are Launcher assertions, not independent OS isolation attestation.

New Runtime instances are not new Launcher deployments. Preserving an opaque handle
inside one session does not establish cross-session, cross-instance or deployment reuse.
Upgrade strict receiver schemas before enabling these optional v1 fields.

- `finance.runtime-launcher-descriptor.v1.schema.json`: Builder-to-platform deployed Launcher handoff.
- `finance.skill-eval.runtime-capabilities.v1.schema.json`: capabilities discovered from the delivered Launcher.
- `finance.skill-eval.runtime-instance.v1.schema.json`: complete instance creation request, including Skill, model, environment, secret references and limits.
- `finance.skill-eval.runtime-instance-state.v1.schema.json`: asynchronous instance lifecycle response.
- `finance.skill-eval.runtime-case.v1.schema.json`: per-case execution request, including workspace test files.
- `finance.skill-eval.runtime-evidence.v1.schema.json`: terminal evidence returned by JSON or by the terminal SSE item.
- `finance.runtime-observation-capabilities.v1.schema.json`: profile and supported-event declaration embedded in Launcher capabilities.
- `finance.runtime-observation.v1.schema.json`: external JSON Schema for normalized events.
- `examples/launcher-descriptor.success.json` and `examples/builder-capabilities.json`: one matching delivery pair.
- `examples/tool-call.completed.json`: one normalized event retaining its framework origin.
- `examples/instance.create.json`, `instance.ready.json`, `case.execute.json` and `execution.evidence.json`: one complete Launcher lifecycle.

## Multi-Skill instance extension

`features.multiSkill: true` opts into `finance.skill-eval.runtime-instance.v2`
on the existing instance endpoint. The request carries `skill: null` and a
`bundle` archive with every member entry and content digest; the worker loads
each member independently. It must verify the archive, bundle digest, member
digests, and full entry coverage before execution. Evidence metadata returns
`bundleDigest` and `loadedBundleMembers`; incomplete receipts fail verification.
The v1 request and single-Skill behavior remain supported.
See [bundle migration](../../docs/multi-skill-migration.md).
