# Private migration target execution V0.1

## Delivered boundary

This increment connects upload/diagnosis, reviewed synthetic mapping, candidate
generation, native OpenJiuwen execution and evidence display. Optimization and
formal Harness/Builder publication are intentionally not enabled by these runs.

PF target execution means **the supplied PF method and references with our
synthetic ports**, not recovery of its omitted implementation, original AgentScope
equivalence, or professional acceptance. Conflicting business instructions remain
visible in diagnosis; generation does not silently decide them.

## Browser steps

1. Sign into the existing private migration workspace and open Skill assets.
2. Upload the PF ZIP or select its existing migration project. Read diagnosis.
3. Choose migration target, then `浦发方法结构 / 合成财报端口`.
4. Review the two read-only port schemas and resource visibility. Explicitly
   acknowledge the synthetic-only boundary, then generate the candidate.
5. Open verification and run the current candidate. The frozen suite contains
   normal financial statements, missing notes, and authorization rejection.
6. Expand each result for the response, actual tool calls and loaded digests.
   Export remains a candidate archive, not a production publication.

Failed/interrupted runs can be retried. Refresh reloads saved runs. A changed
candidate cannot reuse previous evidence; currently a changed method requires
mapping review/regeneration before target execution. Regeneration starts from the
immutable original and does not preserve a manually edited candidate, so export
such edits before regenerating. A dedicated edited-candidate re-review is pending.

## Runtime and assets

- Native SDK: OpenJiuwen Java 0.1.13, Java 21. No SDK source modification.
- `NativeMigrationHost` is our authenticated loopback target, not a source
  project's Host. Uploaded Python/Java is never executed.
- The full canonical archive hash is verified, as are method name/version and
  actual method/resource hashes. Only `METHOD_CONTEXT` resources enter prompts;
  YAML marked `TOOL_ONLY` is parsed on the tool side and not appended to prompts.
- Generated neutral declarations match the Host's explicit synthetic port
  registry. Original parameter-name evidence and project-defined synthetic
  schemas are distinguished. Original output schemas remain unresolved.
- Legacy registration text and uniquely resolved relative resource references
  are adjusted. The original archive remains immutable. Old Python entry points
  remain inert archived material and are not the target entry.
- Local synthetic grant is checked before Agent execution, before each model
  call, around each tool read and before returning the answer. This is not real
  bank IAM acceptance. No business write tool is installed.

## Verification

`MigrationTargetRuns` executes the actual generated candidate through the Host.
Every run records candidate digest, Host/SDK hash, fixture/port hash, model,
case output and observed evidence. Acceptance checks the requested identity,
method/resource hashes, required successful calls and actual model responses.
The missing case checks the method's explicit no-disclosure branch. Denial must
have zero model and business reads. This is functional execution acceptance,
not a model Judge score or professional quality claim.

The target is server-configured through `FINANCE_MIGRATION_NATIVE_ENDPOINT` and
`FINANCE_MIGRATION_NATIVE_TOKEN_FILE`, not an arbitrary frontend-declared URL.
The private route remains authenticated; public demo configuration rejects it.

## Reproduce

```sh
pnpm check
pnpm test
pnpm build
```

In `examples/migration-native-host`:

```sh
mvn -q package dependency:build-classpath -Dmdep.outputFile=target/classpath.txt
```

Back at repository root, with the real model environment loaded:

```sh
node scripts/verify-native-migration-host.mjs /private/output/reference.json
node scripts/verify-pf-native-web.mjs /private/input/pf.zip /private/output/pf-run
```

The first is our independent synthetic reference. The second uses the supplied
archive, actual browser/API generation and real Agent execution. It also checks
stale inputs, refresh, edits, target unavailability and mobile overflow. Private
source archives, credentials and generated PF outputs must not be committed.

## Remaining acceptance

Original PF implementation and AgentScope comparison; business conflict review;
professional quality evaluation; modified-candidate re-review UX; optimizer and
formal publication; independent human operation. Concurrent revocation timing
should be independently audited before extending this Host beyond synthetic data.
