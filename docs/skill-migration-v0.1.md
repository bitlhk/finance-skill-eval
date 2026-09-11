# Skill migration V0.1: private candidate workbench

## Status and baseline

This is a reviewable **partial implementation**, not a completed cross-Runtime
migration product. The earlier private editor is deployed under `/migration/`;
the six-step diagnosis/candidate revision is initially private-preview only.
See [the revised workflow and evidence](skill-migration-diagnosis-v0.2.md).

Development branch: `feat/skill-migration-v01`. Base `7055bfe` preserves the
pre-existing local service/UI 0.4.0 working snapshot on top of `49cff0a`.
That base is not a claim that those changes were accepted upstream. Review the
migration commit against `7055bfe`; review the preserved service baseline
separately before upstream integration. The original worktree is not replaced.

## What works

- Existing normal evaluation continues to use its shared Runtime configuration.
- The private Skill asset page now contains six migration steps. Uploads create/reuse
  a project and automatically diagnose source dependencies. It can create a
  project, inspect files, attach an independently imported candidate, edit its
  method text into a new version, initiate protocol experiments, inspect results,
  cancel jobs through the existing manager, and download complete inert draft bundles.
- Original bytes and candidate snapshots are separate. Edits retain other files;
  stale edits are rejected. Candidate history and notes are retained.
- HTTP/SSE execution supports side-specific environment and asset IDs. Migration
  requires a matching returned loaded-asset digest. Missing/incorrect digests
  fail; non-migration digest behavior is unchanged.
- Archive integrity is rechecked before migration execution/export. Unsupported
  or out-of-root files cannot silently disappear from a Runtime payload/export.
  Export retains all bytes, including unverified dependencies; execution still
  blocks when the current Runtime payload cannot represent the complete package.
  No uploaded script is executed, imported, or installed.
- The selected suite, configuration and declared experiment references are saved
  with each project run. These references do not attest to remote environments.
- Public demo mode and workspaces without an access token reject migration APIs.
  This is a trusted single-user workspace, **not enterprise tenant isolation**.

## What is not implemented or not accepted

| Item | State and next prerequisite |
| --- | --- |
| Original AgentScope baseline A | NOT_RUN: original engineering entry, locked dependencies, complete tools and isolated test data required |
| AgentScope normalized candidate B | NOT_RUN: same native project plus reviewed dependency mapping required |
| Builder OpenJiuwen Java + Harness C | NOT_CONNECTED: a real Java Host adapter remains engineering work; existing Python worker is not a substitute |
| Automatic migration candidate | IMPLEMENTED as deterministic versioned metadata, neutral declaration and adapter drafts with file diffs; arbitrary business-code conversion and complete decoupling remain NOT_IMPLEMENTED |
| Post-evaluation optimization | IMPLEMENTED for complete same-Runtime evaluations with frozen holdout; produces a separate candidate and reruns it. Controlled test passed; not verified on the incomplete supplied native project |
| Dependency equivalence | NOT_VALIDATED: static inventory is not semantic tool mapping or authorization verification |
| Custom customer suite | IMPLEMENTED: project-owned manual preparation with disjoint development/holdout IDs. Business review of the supplied example suite remains pending |
| Immutable remote configuration | NOT_VERIFIED: stored references/suite snapshots do not freeze the actual remote model, data, clock, permissions or environment registry |
| Remote session/cancellation behavior | HTTP cancellation tested; native worker process termination and per-case isolation still require adapter-specific tests |
| Business/method/task equivalence | NOT_VALIDATED: execution completion and relative Judge wins do not establish these claims |
| Release / Builder import | BLOCKED / NOT_VERIFIED: release route fails closed; draft exchange format is not a Builder installation Lock |
| Public website / independent human use | NOT_DEPLOYED / NOT_RUN |

The remaining Java adapter, AI-assisted rewrite and Builder import are development
items, not all external blockers. Missing original engineering materials blocks
claiming A/B/C success but does not turn the incomplete items above into delivered
features.

## Private local use

Requirements: Node 22+, pnpm matching `package.json`, access to this complete
branch and its dependencies. Do not use the old core-only source archive.

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm build
node scripts/serve-migration-preview.mjs
```

Open `http://127.0.0.1:56401`. The preview creates a private token in
`.migration-preview/access-token`; enter it in the local workspace access form.
The token is not placed in a URL. The preview does not automatically import any
customer package or configure a model. It listens only on loopback. Port collision
fails rather than attaching to another service; set `MIGRATION_PREVIEW_PORT` to
another free port. Stop with Ctrl-C. Retain the private data directory to resume.

This mode is for trusted local users. Do not proxy it publicly or share its token.
Original uploads, candidate source, notes and reports can contain confidential
information. Separate enterprise identity and project ACLs are prerequisite to
multi-user customer deployment.

1. Upload a ZIP with `SKILL.md` (legacy lowercase `skill.md` is also accepted).
2. In Skill assets, select the original and create a migration project.
3. Inspect files. Missing dependencies remain unresolved; scripts are inert.
4. Attach another imported version, or edit the method body and metadata version
   and save a new candidate. A new explicit version is required; identity changes
   are rejected for this editing path. Other files are retained byte-for-byte.
5. Register reviewed HTTP Runtime endpoints in the existing environment page.
   They must implement the actual `finance.skill-eval.runtime-request.v1`
   contract from `src/http-runtime.ts`. A generic text-model endpoint is not a
   native original-Runtime baseline.
6. Choose AB, BC or AC, a relevant fixed suite, one execution model and the
   project/data/permission references. Inspect per-side evidence in run history.
   Project suites can be saved through the migration suite JSON editor or
   `POST /api/migrations/:id/suites`, using `manualPreparationSchema` from
   `src/service/contracts.ts`: `summary`, `cases`, and optional `holdoutCases`.
   Saving creates a new immutable preparation; it never overwrites an old suite.
   Include business-reviewed holdout cases before attempting optimization.
7. Inspect the migration report. A completed HTTP experiment is still not a
   migrated/validated Skill. Release remains closed until the missing acceptance
   path is implemented and independently verified.
8. Draft export includes a manifest, associated report and raw-file SHA-256 values, not an install
   Lock. Asset identity uses the existing canonical archive fingerprint, which
   is different from hashing the ZIP bytes. Scripts/out-of-root dependencies
   are retained inertly and marked unverified. They are never run during export.
   Existing `migration-manifest.json` or `migration-report.json` paths cause
   rejection rather than overwriting source files. This archive is for transfer
   and review, not automatic installation.
9. After a complete same-Runtime evaluation, open its optimization panel. The
   existing optimizer reads development evidence only, creates another asset,
   and reruns original/candidate in the right-hand target environment with
   updated side bindings. Holdout does not enter the editor prompt. A cross-stack
   comparison is not accepted as evidence of a Skill-only defect.
10. A locally adopted optimized candidate is associated with its migration project
    and can be edited, evaluated or exported again. If the base candidate changed
    while optimization was running, adoption is rejected. Adoption is not release.

## Comparison semantics

- AB: original Runtime held fixed, original versus normalized Skill.
- BC: normalized Skill held fixed, original stack versus target Java/Harness
  stack. Harness governance differences are included, not pure Runtime effects.
- AC: final original versus migrated stack comparison.

The service checks pair asset bindings, common model and AB environment identity.
It does not establish that an endpoint actually runs AgentScope/Java. Declared
project and lock references are retained as **declared**, not marked verified.
Existing report fields from a worker are not independent identity attestation.

## Regression commands

```sh
pnpm test
pnpm check
pnpm build
CHROMIUM_PATH=/path/to/chromium node scripts/verify-migration-ui.mjs reports/migration-ui
```

The browser script uses synthetic data and the real private Fastify service on
an ephemeral loopback port. It removes its temporary workspace and closes its
browser/server. It does not call a real model or native customer Runtime.
`tests/migration-http.test.ts` uses real isolated HTTP sockets to check routing
and cancellation, explicitly returning unverified Runtime identity.

Tests cover legacy import, ambiguous roots, source retention, disk tampering,
stale edits, incomplete exports, disabled release, public/anonymous rejection,
side routing, digest enforcement and cleanup. Existing tests remain in scope.

## Materials and ownership to unlock acceptance

Customer/scene owner: supply complete original AgentScope startup project,
dependency lock/version, full tool implementations, read-only test identities,
data snapshot/expected facts, and resolve conflicting method definitions. Do not
send production secrets in the Skill package.

Runtime/Integrator engineer: implement version-specific native entry adapters,
loaded-asset verification against deployed artifacts, isolated sessions, and
worker-side cancellation. Java target must use the actual Builder-generated
Host; use no replacement script-model baseline.

Harness/Builder engineer: review input/output/error and side-effect mapping, then
implement and test draft import compatibility. Builder generates the install Lock.

Business reviewer: approve the fixed suite, acceptable semantic differences and
method/task thresholds before running experiments. Review held-out results
separately from development edits. Independent human use is a separate acceptance.

## Compatibility and rollback

Existing run configurations without `runtimeBindings` retain their execution
path. Migration records use their own versioned directory; optional new history
and experiment fields permit reading the earlier local prototypes.

No online deployment or data migration is part of this delivery. Stop only the
private preview process to disable it. Keep its data for inspection; do not delete
original uploads while cleaning build outputs. Do not reset the original dirty
worktree or replace the public service with this branch.
