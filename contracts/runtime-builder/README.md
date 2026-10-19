# Runtime Builder file contracts

`finance.runtime-build-requirements.v1` is emitted only when every required Runtime capability has machine-readable input, output, error, permission, side-effect and isolation semantics. Legacy free-text-only findings return `INCOMPLETE_REQUIREMENTS` and are not executable build requests.

`finance.runtime-build-result.v1` returns a deployed Runtime Launcher, not a downloadable Runtime package. `SUCCEEDED` requires a `finance.runtime-launcher-descriptor.v1`; every other status requires `launcher: null`. Both Builder digests use RFC 8785 canonical JSON and SHA-256, excluding the digest field itself.

The receiver must fetch `GET /v1/runtime-capabilities` from the returned Launcher and pass that response to `validateRuntimeBuildResult()`. Acceptance verifies the request/result digests, required capability evidence, Runtime identity, protocol versions, Launcher capabilities digest and observability declaration. A descriptor alone is not proof that the deployment is usable.

The requirements protocol names are `capabilities`, `instance`, `execution` and `observation`; there is no separate registration protocol. Models, default model, MCP support and limits are discovered from Launcher capabilities and are not copied into the Builder result.

An iterative Harness change may add the optional `rebuild` object to the same v1 request. It identifies the previous solution revision and Launcher deployment, a test-backed hypothesis, and references to actual Eval job/case evidence. It does not carry raw business inputs, secrets or framework-specific construction instructions. A successful rebuild must return both a new `deploymentId` and a different Launcher `artifactSha256`; Eval then performs its own Launcher conformance and business evaluation. A new identity alone does not prove that the hypothesis improved results.

This directory defines the build request/result documents only. Submission, polling, callbacks and cancellation transport are outside v1. Deployment is the Builder's responsibility. Credentials are resolved by the receiving environment and must never be embedded in either document.

## Unified migration task profile

Single and multiple Skill tasks use the same optional v1 envelope extension, required when present:

- Requirements `extensions.migrationTask`: [finance.migration-task-build-profile.v1](finance.migration-task-build-profile.v1.schema.json).
- Result `extensions.migrationTask`: [finance.migration-task-build-receipt.v1](finance.migration-task-build-receipt.v1.schema.json).
- Matching illustrative documents: [requirements](examples/task.requirements.success.json), [result](examples/task.result.success.json), [capabilities](examples/task.capabilities.json). These are protocol examples, not records of a live deployment.

The profile pins task/source/candidate identity, all 1–10 member entries and digests, file paths, packaged services and execution settings. The downloaded source ZIP is bound to that request's immutable candidate. The profile requires `finance.skill-eval.runtime-instance.v2` and `features.multiSkill=true`, including for one member. The outer descriptor keeps the baseline v1 protocol declaration; v2 is the additional required protocol. A Builder unable to honor the profile must return an explicit failure, not silently ignore the extension.

The receipt must echo task ID, candidate ID/digest and the v2 instance version; it is covered by the outer `resultDigest`. The receiver uses its saved requirements and source snapshot, validates the live capabilities and required native contracts, then executes create/status/execute/evidence/delete with every member loaded. A profile-bearing request cannot be admitted through the old v1-only intake. Native capability declarations still require structured contracts; natural-language analysis is context, not proof of implemented semantics.

Binding includes candidate, request, result, configuration and admitted environment snapshot. Replacing a request, generating a candidate or changing configuration prevents reuse of the prior binding. Business acceptance and verified export recheck the binding and runtime environment. Existing unextended v1 requests and historical tasks retain their previous behavior. See [operation and HTTP guide](../../docs/runtime-builder-integration.md).
