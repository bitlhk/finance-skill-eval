# Skill Environment Selection

The comparison page now exposes three explicit goals: compare Skill versions,
compare models, or compare Runtimes. Skill comparison keeps the model shared;
model comparison keeps the Skill version shared; Runtime comparison keeps both
shared and uses the existing dual-Launcher request contract and fixed cases.
If only one model is available, model comparison explains the limitation instead
of pretending to compare two models.

The catalog projects tool declarations from the digest-checked uploaded archive
and existing Runtime capability inspection. This is advisory matching, not new
admission, authorization or a second dependency registry. Build-time contracts,
observability qualification, installation Lock and runtime authorization remain
unchanged. No bank/module/Skill ID is embedded in matching logic.

- A unique compatible environment for the selected framework is selected.
- An existing compatible choice is retained.
- Multiple compatible data sources require user selection; matching never infers
  that equal tool names imply equal data or permission.
- Missing tools, failed inspections and primary-package requirements are shown.
- Explicit `allowed-tools: []` can match the tool-free profile. An absent
  declaration is unknown, not proof of a tool-free Skill.
- External MCP support alone does not prove the missing tools are installed.
- Uploaded preparations default to the managed temporary-Agent path. Explicit
  text-only execution remains an available option where supported.

The two Runtime environments still appear by their registered names and can be
changed explicitly. Registry labels are operator-maintained metadata, not a
front-end dictionary. Automatic selection does not certify source equivalence;
the existing fixed-data acceptance and build evidence are still required.

The lifecycle caption says automatic reclamation is initiated after evaluation;
it does not turn a run result into a verified cleanup receipt. The existing
Launcher and Builder mechanisms retain failure, timeout, cancellation and cleanup
evidence. No new cleanup protocol or Runtime is introduced by this UI change.

Verification:

```sh
pnpm check
pnpm exec vitest run tests/environment-matching.test.ts tests/skill-runtime-requirements.test.ts
pnpm build:web
node scripts/verify-environment-matching-ui.mjs /tmp/eval-matching-ui
```

The browser test uses a synthetic catalog and captures, but does not execute, an
evaluation request. It verifies single/dual selection, switching Skill, missing
dependencies, no-tool methods, single-model rejection, and1366/390/320px layouts.
It is not native execution, real-model quality or genuine Linggan SSO evidence.
