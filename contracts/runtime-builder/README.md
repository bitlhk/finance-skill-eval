# Runtime Builder file contracts

`finance.runtime-build-requirements.v1` is emitted only when every required Runtime capability has machine-readable input, output, error, permission, side-effect and isolation semantics. Legacy free-text-only findings return `INCOMPLETE_REQUIREMENTS` and are not executable build requests.

`finance.runtime-build-result.v1` is accepted only through `validateRuntimeBuildResult()`. Both digests use RFC 8785 canonical JSON and SHA-256, excluding the digest field itself. Artifact bytes must be supplied to acceptance so the declared artifact digest is not trusted on its own.

This directory defines file exchange only. Submission, polling, callbacks, cancellation, deployment and credentials are outside v1.
