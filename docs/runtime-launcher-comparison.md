# Private native Runtime comparison

This extends the existing five-endpoint Launcher protocol. It does not add a
runtime, a trading route, a public upload endpoint, or a new evaluation engine.

## Configure and use

1. Register two authenticated `runtime_launcher` environments in the private
   workspace. Their managed presets must admit the same read-only method and
   capabilities. Credentials remain in server-side environment bindings.
2. Import the original Skill ZIP and prepare a fixed case set. An unpublished
   execution-admitted candidate is supported; formal publication is not required.
3. Open the existing evaluation page, choose the dual-Runtime instance mode,
   select both environments and the same Skill version and model, and enter
   `temperature`, `top_p`, and `max_tokens`.
4. Start evaluation. Each case uses a fresh native session. The Launcher checks
   the selected method, its dependencies and qualified installation before use.
5. Inspect each answer's Runtime identity, installed method digest, Lock digests,
   history request ID and retained evidence reference. Cleanup removes temporary
   execution instances, not the retained version/evidence metadata.

## Contract additions

- Failure observations are correlated to the requested run, case, side and
  instance before being forwarded. Recognized Builder native diagnostics retain
  only bounded build/Host/run/trace identifiers, with the basis
  `LAUNCHER_CORRELATION_NOT_EXECUTION_VERIFICATION`. The runner keeps these lookup
  keys on failed evidence without asserting installed Skills, identity, tools or
  model parameters; failed cases are not quality-scored or automatically retried.
  Old failures without these identifiers remain unchanged.
- The isolated native browser probe checks a preset Pack's fixture identity
  before executing it. Its one-account controlled bank is not interchangeable
  with the candidate site's five-account snapshot. A fixture mismatch is a test
  setup failure, not a Runtime quality result.

- `RuntimeInstanceRequest.generation` is optional for older clients. When present,
  all three parameters are required with `schemaVersion=finance.eval-generation.v1`.
  An optional `thinking: {type: "disabled"}` is supported only when the managed
  Builder model binding explicitly declares `generationExtensions: ["thinking.disabled"]`.
  Omission preserves the endpoint default. Unknown modes/options reject; no proxy
  silently adds this field. Both sides must use the same parameters, with their
  frozen configuration and actual request checks reported separately. An older
  Launcher may reject the extension; Eval does not silently retry without it.
  Unknown keys, incomplete settings, invalid numbers and unsupported values are
  rejected, not silently discarded. Empty legacy model parameters omit this field.
- `capabilities.nativeToolNames` optionally advertises preset-scoped native tools.
  Eval uses only the authenticated preflight inventory to distinguish native tools
  from external MCP dependencies. It still sends all required names to the Launcher;
  inventory discovery is not installation or authorization.
- Explicit generation settings require matching `declaredModelParameters` and
  `modelGenerationHostVerified=true` in execution evidence. This verifies the Host
  configuration, **not** what a model endpoint received. Wire-level evidence is
  measured separately with a controlled receiver or approved managed relay.

Deploy the new Builder Launcher and Eval client together. Older clients with a
strict capabilities schema may reject the added field. Existing public services
are not implicitly upgraded by these source changes.

## Verification boundaries

`scripts/verify-launcher-ui.mjs` starts a private Eval service against an explicitly
provided native Launcher fixture. It uploads a real ZIP through the browser,
uses fixed repeated cases, and checks both Runtime bindings, generation settings,
tool execution, method/Lock/history references, session isolation and responsive
result rendering. `LAUNCHER_FIXTURE_INFO` is a private fixture file; never publish
its bearer token. `LAUNCHER_UI_OUTPUT` must be a new directory.

`LAUNCHER_UI_EXECUTION_MODE=LIVE` requires actual live-model fixture descriptors;
it does not by itself select a real Judge. Set `LAUNCHER_UI_JUDGE_MODE=LIVE`
and provision the existing server-side Judge connection to verify both real
execution and real assessment. The default remains a controlled Judge that
returns INDETERMINATE, not a substitute for live scoring. Live acceptance requires
actual server-authorized tool result projections, not answer-derived facts.
The script waits up to 120 seconds for real native preflight without bypassing
it, checks each side's RELEASED cleanup receipt separately, and retains failed
attempts as failures rather than treating request acknowledgement as release.
The two repeated balance cases verify this path only, not all migration scenarios.

Controlled model output proves plumbing and isolation, not answer quality. A
nonempty response, matching parameters or successful tool execution does not
prove task completeness. A real-model run is separately labeled; a small repeated
case set must not be used to rank the frameworks generally. Native prompts and
tool schemas can differ and must remain available in the captured evidence.

No model credentials, real customer data or hidden reasoning should be included
in the retained comparison reports. Human independent use and professional quality
review remain distinct from automated browser acceptance.
