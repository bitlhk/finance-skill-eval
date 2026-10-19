# Runtime Builder file contracts

New tasks use [requirements v2](finance.runtime-build-requirements.v2.schema.json) and
[result v2](finance.runtime-build-result.v2.schema.json), with the v2 instance protocol.
The v1 documents below remain available only for legacy task compatibility.

`finance.runtime-build-requirements.v1` is emitted only when every required Runtime capability has machine-readable input, output, error, permission, side-effect and isolation semantics. Legacy free-text-only findings return `INCOMPLETE_REQUIREMENTS` and are not executable build requests.

`finance.runtime-build-result.v1` returns a deployed Runtime Launcher, not a downloadable Runtime package. `SUCCEEDED` requires a `finance.runtime-launcher-descriptor.v1`; every other status requires `launcher: null`. Both Builder digests use RFC 8785 canonical JSON and SHA-256, excluding the digest field itself.

The receiver must fetch `GET /v1/runtime-capabilities` from the returned Launcher and pass that response to `validateRuntimeBuildResult()`. Acceptance verifies the request/result digests, required capability evidence, Runtime identity, protocol versions, Launcher capabilities digest and observability declaration. A descriptor alone is not proof that the deployment is usable.

The requirements protocol names are `capabilities`, `instance`, `execution` and `observation`; there is no separate registration protocol. Models, default model, MCP support and limits are discovered from Launcher capabilities and are not copied into the Builder result.

An iterative Harness change may add the optional `rebuild` object to the same v1 request. It identifies the previous solution revision and Launcher deployment, a test-backed hypothesis, and references to actual Eval job/case evidence. It does not carry raw business inputs, secrets or framework-specific construction instructions. A successful rebuild must return both a new `deploymentId` and a different Launcher `artifactSha256`; Eval then performs its own Launcher conformance and business evaluation. A new identity alone does not prove that the hypothesis improved results.

This directory defines the build request/result documents only. Submission, polling, callbacks and cancellation transport are outside v1. Deployment is the Builder's responsibility. Credentials are resolved by the receiving environment and must never be embedded in either document.

## Unified migration task profile

All new tasks use the same 1–N Skill contract:

- Requirements extension: [task profile v2](finance.migration-task-build-profile.v2.schema.json), with `skills[]` metadata.
- Result extension: [task receipt v2](finance.migration-task-build-receipt.v2.schema.json).
- Illustrative v2 [requirements](examples/task.v2.requirements.success.json), [result](examples/task.v2.result.success.json), [inline Skills](examples/skills.v2.json); these are examples, not live deployment records.
- Inline input: `skills[]` with instructions and optional member `files`, optional shared `assets`, and `contentDigest`.
- Both build target and Launcher descriptor declare `finance.skill-eval.runtime-instance.v2`.

A Skill does not need a project, archive or dependency file. Eval exports `skills.json` bound to the immutable candidate; ZIP is only an optional import/export convenience. The file-tree digest and each member digest still protect the exact input bytes. A Builder unable to honor inline v2 must fail explicitly.

The receipt must echo task ID, candidate ID/digest and the v2 instance version; it is covered by the outer `resultDigest`. The receiver uses its saved requirements and source snapshot, validates the live capabilities and required native contracts, then executes create/status/execute/evidence/delete with every member loaded. A profile-bearing request cannot be admitted through the old v1-only intake. Native capability declarations still require structured contracts; natural-language analysis is context, not proof of implemented semantics.

Binding includes candidate, request, result, configuration and admitted environment snapshot. Replacing a request, generating a candidate or changing configuration prevents reuse of the prior binding. Business acceptance and verified export recheck the binding and runtime environment. Existing unextended v1 requests and historical tasks retain their previous behavior. See [operation and HTTP guide](../../docs/runtime-builder-integration.md).
