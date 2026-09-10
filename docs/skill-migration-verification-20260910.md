# Skill migration local verification - 2026-09-10

Scope: private migration branch, not the public website. Original customer code
was not executed. No real model, bank, AgentScope project or Builder Java Host was
invoked. No production service or customer data was migrated.

## Actual checks

| Check | Result |
| --- | --- |
| `pnpm check` | PASS (core, examples, web TypeScript) |
| `pnpm build` | PASS (core and production web assets) |
| `pnpm exec vitest run --reporter=json --outputFile=...` | 72 tests PASS, 0 failed, 0 skipped |
| `scripts/verify-migration-ui.mjs` against actual compiled service | 10 checks PASS; desktop 1440px and mobile 390px |
| Real isolated HTTP side routing and cancellation | PASS; synthetic protocol endpoint, not a native Runtime |
| Local preview `127.0.0.1:56401/api/health` | ready, local-workspace |
| Original package archive checksum | unchanged from received checksum |
| Original AgentScope A/B execution | NOT_RUN, incomplete original engineering materials |
| Java/Harness C execution | NOT_CONNECTED, adapter development remains |
| Independent business/human validation | NOT_RUN |
| Public deployment and Builder import | NOT_DEPLOYED / NOT_VERIFIED |

Browser checks: private workspace login, source project creation, visible missing
materials, editing into a new candidate version, missing Runtime preventing run,
per-side selection, draft-not-release export, persistence after refresh, no mobile
overflow, and no browser exceptions. A prior browser assertion failed because it
checked the project count before the async list finished loading; the final test
waits for the actual list and passed. This is not presented as a product data-loss
bug.

Tests include failure and safety paths. There was no comprehensive pre-fix replay
of every new regression against the old baseline; do not claim such coverage.

## Customer package findings

The private example package was received and safely inventoried. It contains a
Skill, two reference files and two Python files. Source bytes remain outside this
repository and outside public assets. No script was imported or run.

Missing: full data-query implementation, decorator and other referenced modules,
AgentScope startup, dependency lock and isolated authorized data setup.
Method issues for owner review include inconsistent short/long borrowing naming,
reference directory spelling, and conflicting instructions about missing facts.
Formatting compatibility is implemented; these business choices are not silently
rewritten. Format-only import is not a valid native execution baseline.

## Evidence location and preview

Local synthetic evidence: `/home/ubuntu/outputs/skill-migration-ui-final/`
contains `tests.json`, `checks.json`, desktop/mobile screenshots and a synthetic
draft ZIP. It contains no customer source files. This machine-specific path is
not a public publication or an upstream CI run.

Private preview runs as user unit `finance-skill-migration-preview`, only on
loopback 56401. Stop with `systemctl --user stop finance-skill-migration-preview`.
Access token is generated in `.migration-preview/access-token` with mode 0600.
Do not copy that file into a commit or a public report.

## Completion boundary

Completed here: reviewable private candidate-management and protocol-validation
foundation with regression evidence. The end-to-end migration goal is still open.
See [implementation and outstanding work](skill-migration-v0.1.md) for the native
adapters, semantic mapping, automatic rewrite, custom suite and Builder import
work that remains. Do not describe these merely as external acceptance delays.
