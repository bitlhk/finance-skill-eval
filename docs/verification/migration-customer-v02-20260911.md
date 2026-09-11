# Customer migration V0.2 verification

Baseline: main `489336ab097e7cb6d135eae9ece6195797064063` (PR #1 merge).
Development branch: `feat/migration-customer-workflow-v02`.
The original source worktree and private customer workspace were preserved.

## Scope

- Independent ZIP/Markdown intake, up to ten files, sequential and isolated failures.
- Content-based diagnosis and evidence-linked action categories; Java imports are lexical only.
- Generic versioned proposals do not require the PF Skill/profile. Unknown ports remain unbound.
- Regeneration inherits edited methods/resources; changed/unknown generated adapters cause conflicts.
- Four-step navigation, current-version target status, separate original comparison and admin review.
- Export summaries omit raw execution answers and configuration, distinguish verified target from draft,
  and reject common credential paths/literals. This is not a general DLP implementation.

## Local checks

Commands: `pnpm check`, `pnpm test`, private Vite build and
`scripts/verify-migration-ui.mjs` with the private gateway/subpath variables in the customer guide.

The local full regression contains 96 tests in 31 files. Browser regression contains 19 checks,
including generic non-PF draft export, mixed batch failure and preservation of edited method text.
The target protocol test checks edit → mapping reapproval/regeneration → current candidate execution,
stale manual review rejection, old review isolation and exported bytes restored by reimport.

The initial browser replay required opening the editor again after changing steps; the selector
was corrected to follow the visible UI. No application boundary was bypassed to pass the replay.

## Remaining boundaries

- No arbitrary language translation, automatic business implementation or dynamic third-party installation.
- New tools still need explicit registration, schemas, trusted host identity and mapped resources.
- Java semantic compilation, source AgentScope equivalence, professional acceptance, independent human
  participation and upstream Builder integration are not established by these tests.
- The admin review endpoint records an authenticated workspace statement, not verified human identity
  beyond the existing single-admin token boundary. Automation tests do not constitute human review.
- Original files stay inert. Framework references can remain in archived original source; complete
  framework removal is not claimed. Generated runtime bindings are confined to the generated adapter area.
- Exported user method/resource content still requires owner privacy review before sharing.

Post-commit CI and deployed real-model synthetic-port results are attached to the PR, with the exact
commit and release identity. Historical evidence remains available and is not relabeled as this run.
