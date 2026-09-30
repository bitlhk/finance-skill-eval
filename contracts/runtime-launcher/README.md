# Runtime Launcher v1 contract

This directory is the portable contract for Runtime Launchers returned by an external Runtime Builder. A Launcher implementation is framework-neutral at this boundary: it translates framework-native lifecycle callbacks into stable Finance Runtime events and may attach a sanitized native extension.

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

## Observability boundary

The stable `kind` in `finance.runtime-observation.v1` describes cross-framework semantics, not a framework callback name. `source.nativeEventType` records the original callback name when one exists. `source.synthesized=true` means the Launcher inferred the event from a boundary it controls. Optional `native.data` is diagnostic-only, must be JSON, sanitized and bounded by the transport implementation.

Launcher capabilities may advertise an `observability` object:

- `core` requires execution start, completion and failure events.
- `tool` additionally requires model-call and tool-call start, completion and failure events.
- `detailed` has the same normalized minimum as `tool` and also carries sanitized native event extensions.

Profiles are minimum guarantees. `supportedKinds` is the exact set a Launcher may emit and must include the minimum for its profile. Absence of `observability` identifies a legacy Launcher and must not be interpreted as Tool-level visibility. Builder-delivered Launchers must declare it.

Acceptance may depend only on final execution evidence and the `core` guarantee. Missing optional events cannot fail migration acceptance. Optimization and diagnostics may use richer events only after recording the declared profile. Neither normalized nor native events may contain hidden chain-of-thought, credentials, authorization headers or unredacted sensitive business values.

Framework-specific consumers must use `native` data explicitly. Portable consumers must ignore it and use only normalized fields.

## Files

- `finance.runtime-launcher-descriptor.v1.schema.json`: Builder-to-platform deployed Launcher handoff.
- `finance.skill-eval.runtime-capabilities.v1.schema.json`: capabilities discovered from the delivered Launcher.
- `finance.runtime-observation-capabilities.v1.schema.json`: profile and supported-event declaration embedded in Launcher capabilities.
- `finance.runtime-observation.v1.schema.json`: external JSON Schema for normalized events.
- `examples/launcher-descriptor.success.json` and `examples/builder-capabilities.json`: one matching delivery pair.
- `examples/tool-call.completed.json`: one normalized event retaining its framework origin.

