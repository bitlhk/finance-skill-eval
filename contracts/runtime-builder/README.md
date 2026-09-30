# Runtime Builder file contracts

`finance.runtime-build-requirements.v1` is emitted only when every required Runtime capability has machine-readable input, output, error, permission, side-effect and isolation semantics. Legacy free-text-only findings return `INCOMPLETE_REQUIREMENTS` and are not executable build requests.

`finance.runtime-build-result.v1` returns a deployed Runtime Launcher, not a downloadable Runtime package. `SUCCEEDED` requires a `finance.runtime-launcher-descriptor.v1`; every other status requires `launcher: null`. Both Builder digests use RFC 8785 canonical JSON and SHA-256, excluding the digest field itself.

The receiver must fetch `GET /v1/runtime-capabilities` from the returned Launcher and pass that response to `validateRuntimeBuildResult()`. Acceptance verifies the request/result digests, required capability evidence, Runtime identity, protocol versions, Launcher capabilities digest and observability declaration. A descriptor alone is not proof that the deployment is usable.

The requirements protocol names are `capabilities`, `instance`, `execution` and `observation`; there is no separate registration protocol. Models, default model, MCP support and limits are discovered from Launcher capabilities and are not copied into the Builder result.

This directory defines the build request/result documents only. Submission, polling, callbacks and cancellation transport are outside v1. Deployment is the Builder's responsibility. Credentials are resolved by the receiving environment and must never be embedded in either document.
