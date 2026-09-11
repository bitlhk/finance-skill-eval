# Skill migration: evidence-led diagnosis and candidate review

## Product correction

The previous version managed experiments and edited method files. It did not
automatically migrate a runtime-bound Skill. This revision first implements:

1. Upload a ZIP using the existing private asset API, or choose an existing asset.
2. Automatically create/reuse the same named source project and diagnose it.
3. Select an OpenJiuwen target (registered environment, or explicitly unconnected
   draft), then generate a reviewable candidate and actual file diffs.
4. Inspect functional verification prerequisites; the advanced AB/BC/AC controls
   are folded away. Missing native material does not block steps 1-3.
5. Optimize only after the necessary migration validation. New generated
   migration candidates currently stay blocked here because target Host
   acceptance is not implemented. Legacy ordinary evaluation is unaffected.
6. Optionally export an inert draft. Harness release remains disabled. Skipping
   expression optimization does not prevent draft export.

The generated result is an engineering review candidate, not a promise that
arbitrary uploaded Python has been transformed into a runtime-independent Skill.

## Diagnostics

`scripts/scan-migration.py` consumes archive text through stdin and uses Python
AST/tokenize. It never imports uploaded modules. The TypeScript wrapper imposes
a 15-second timeout and output limit. All archive paths/bytes are checked by the
existing SkillStore before inspection. Python 3.10+ is needed for scanning.

Evidence includes path, exact line/snippet, category, reason, impact, suggestion,
confidence and layer. Supported observations include executable SDK imports,
ToolResponse/TextBlock constructors, host tool registration/custom Schema,
method resource injection, missing relative resources/modules, unpinned external
modules, explicit omitted implementation, dynamic imports and top-level calls.
Comments and docstrings do not become executable imports. An omitted-code
comment is specifically evidence of incomplete material, not an import.

States are intentionally distinct:

- EXPLICIT_BINDING: syntax evidence of framework/host binding exists.
- NO_BINDING_IN_CHECKED_SCOPE: no binding in inspected syntax; NOT a proof of
  all possible runtime behavior or readiness.
- UNKNOWN: no binding established and material/coverage is incomplete.

Each file has a coverage status. Unsupported languages, large/binary files,
parse failures and missing modules prevent a complete-material conclusion.
This is syntax inspection, not full Python control-flow/type/import resolution.
Aliases are recognized for common direct imports; arbitrary monkey-patching,
reflection and dependency transitive behavior are not proven by this scanner.
Diagnosis caches bind to source digest and scanner digest; source bytes remain
immutable. Projects with different names remain separate even with one source.

## AI explanation

The configured ANALYZER model explains the static findings. Code/Markdown text
from the entire readable package is considered, not only SKILL.md. Tool-only
JSON/YAML values are withheld from model context; they remain statically
inspected. Common credential literals are redacted. The model input is bounded;
truncation is explicitly recorded. This does not constitute comprehensive DLP.

The model has no tools or script executor. Uploaded text is explicitly untrusted.
Suggestions must reference existing finding IDs and cannot change static status.
RUNNING, COMPLETE, NOT_CONFIGURED and FAILED are separate persisted states;
unavailable/invalid model configuration and failed responses are retryable,
never converted into successful AI analysis. Restart-interrupted explanation is
reported as interrupted and can be retried. AI explanations remain non-authoritative.

## Candidate generation

`migration-candidate.ts` generates:

- System-generated metadata version; the original business body is retained.
- `migration-generated/neutral-contract.json`: proposed capability and resource
  references; missing schemas are null, not guessed. Resource path alternatives
  are proposals requiring review. Tool-only configuration stays distinct from
  method context.
- `neutral_result.py`, `agentscope_result_adapter.py`,
  `OpenJiuwenMigrationTool.java`: actual typed/result/registration bridge drafts.
  Host-owned authorization callbacks are mandatory. SDK calls remain inside
  adapters, not the neutral declaration.
- Review notes and a README recording missing business implementation, resource
  projection, schema review and native Host tests.

Original helper files remain byte-for-byte intact and are NOT imported. The
source method may still describe original resource injection; its full decoupling
is not accepted by this generation step. Tool-name extraction currently handles
explicit get/query/read/fetch declarations, not arbitrary tool discovery.
No claim is made that this proposal already matches Harness Capability Pack or
Builder import schemas. Async source registration and actual source SDK version
still require original AgentScope verification.

Selecting a registered target verifies its record/type, NOT its online identity,
authorization, installed adapter or semantic compatibility. An unconnected
OpenJiuwen draft is labeled as such and cannot be counted as target execution.

Edits generate new versions without requiring users to edit metadata. Optimistic
base checks reject stale writes. Old reports retain old digests and cannot become
acceptance for a changed candidate. Public migration release remains rejected.

## Verification and limitations

Automated tests cover pure methods, comment-only SDK mentions, aliases, host
registration, resources, missing modules, dynamic imports, omitted code, invalid
syntax, no uploaded execution, AI failure/retry and invalid evidence IDs,
idempotent creation, wrong target, real candidate files and stale version checks.
The browser test exercises upload-triggered diagnosis, generation, versioned
editing, stale validation, export and mobile layout with an isolated service.

The private supplied package probe checks every finding against the exact source
line. It preserves all non-method bytes and exports actual candidate files. The
probe can compile our generated Java bridge against OpenJiuwen 0.1.13 and invoke
the real SDK Tool with a controlled business callback: allowed, denied before
read, and revoked before result return. This is NOT a complete Agent/Host or
customer business run. Uploaded Python is never executed by the probe.

```sh
pnpm check
pnpm test
pnpm build
CHROMIUM_PATH=/path/to/chromium node scripts/verify-migration-ui.mjs reports/diagnosis-ui
OPENJIUWEN_TEST_JAR=/path/to/agent-core-java-0.1.13.jar \
OPENJIUWEN_TEST_CLASSPATH_FILE=/path/to/maven-resolved-classpath.txt \
node scripts/verify-migration-diagnosis.mjs /private/source.zip /private/new-evidence
node scripts/verify-migration-ai.mjs reports/real-ai.json
```

The last command requires the configured ANALYZER model and sends only its
synthetic package. Customer diagnosis/export evidence belongs outside Git.

## Remaining ownership

| Work | Owner | Acceptance |
| --- | --- | --- |
| Missing native modules, complete query implementation, dependency lock and baseline startup | Original project owner | Isolated AgentScope baseline with actual supplied implementation |
| Long/short borrowing terminology and missing-data output conflict | Business owner | Explicit business decision; not silently rewritten |
| Neutral declaration loader, resource projection and target adapter installation | This project's Harness/Host developers | Actual target Host uses generated asset, exact digest and trusted context |
| Same data, role and permission bindings across runtimes | Host/integration + source owners | Paired functional cases; no invented authorization |
| Expression optimization | Evaluation developers after functional validation | New candidate, development/holdout separation and regression |
| Harness/Builder import | Harness/Builder owners | Import schema/installation Lock and actual runtime evidence |

Real model explanation is not real native migration. Controlled adapter calls are
not customer query acceptance. The preview deliberately exposes these gaps.
