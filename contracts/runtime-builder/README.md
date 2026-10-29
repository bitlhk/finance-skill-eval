# Runtime Builder contract

`finance.runtime-build-requirements.v3` accepts generic capability requirements and `executionRequirements` (platform, required features, capacity). It does not contain business Skills, Eval task/candidate identifiers, source bundles or migration extensions.

`finance.runtime-build-result.v3` binds the exact RFC 8785 request digest to capability evidence and a deployed `finance.runtime-launcher-descriptor.v2`. SUCCEEDED requires a launcher and a passed RUNTIME_LIFECYCLE verification with an evidence SHA-256. Other statuses have launcher: null.

Receivers fetch actual capabilities, compare protocol/platform/contract/permissions/side effects/isolation/capacity, verify digests, then perform an independent platform-owned start/execute/release probe. Business acceptance is a separate caller responsibility. A capability name, descriptor, or build exit code alone is insufficient evidence.

The same Runtime accepts 1–N Skills through the standard startup collection. No business Skill is compiled into this build protocol. Old build v1/v2 and migration profile/receipt formats are rejected.

- [Requirements schema](finance.runtime-build-requirements.v3.schema.json)
- [Result schema](finance.runtime-build-result.v3.schema.json)
- [Generic request](examples/requirements.success.json)
- [Result](examples/result.success.json)
- [Startup Skill collection](examples/skills.json)
- [Launcher boundary](../runtime-launcher/README.md)
