# Ordinary accounts: managed-profile browser acceptance

## Policy and scope

Any authenticated Linggan account may use an isolated workspace. There is no
administrator allowlist. Approved synthetic seed content is shared by copying;
personal uploads, migrations and runs are not shared. Server connection and
execution admission remain managed. Bank grants are not inferred from login.

This check extends the existing controlled full-profile browser cohort rather
than adding another execution path. It covers six curated prebuilt Skills,
wealth upload and migration, the method-only coaching Skill and bank/file Skill.
Each case uses both OpenJiuwen Java0.1.15 and AgentScope Java2.0.3.

Evidence root: `/home/ubuntu/outputs/eval-formal-entry-release`.
`account-managed-profiles-r5/report.json` is PASS. These are worktree checks of
the accompanying implementation, not a falsely relabeled fixed-commit or public
deployment run. Eval base59af867, Builder basedab2d7f9 and unchanged Harness8f2c6a0.

## Full controlled results

- Ten browser paths and44 native executions completed, with44 distinct sessions,
  in the same Eval service/workspace without restarting it. Three managed source
  profiles expose the same two Runtime families, not six different Runtimes.
- Six curated prebuilt entries, wealth upload, wealth migration, no-tool coaching
  and bank/file entry all passed their workflow checks. Another account could not
  read or export any of these runs. The earlier two-account native probe separately
  verifies both accounts can execute, not just that one is denied access.
- Curated source ledger matched88 expected business calls. Method-only execution
  made zero bank reads and sent no tools. Bank/file fact and workspace checks PASS.
- Actual snapshot files contain136 model request/response pairs,272 files and
  1,951,924 bytes. All44 request archives closed, with zero dropped events,
  missing digests, unconfirmed writes or write failures. This is file/reference
  verification, not merely a successful enqueue status.
- All three owned Launcher/Host groups and the synthetic bank exited cleanly.
  No production service, policy, data or old Agent changed.
- Browser1366/390/320px checks passed. Migration result screenshots at1366 and320
  were inspected; both display the installed method and two Runtime results.
  Judge remains INDETERMINATE rather than claiming business-quality approval.

## Regression found and fixed

The account work limiter initially counted every POST preflight. Normal model
and Runtime selection could consume the start allowance, so migration reached a
valid candidate but could not begin evaluation. Preflight only inspects managed
capabilities; it neither builds an Agent nor executes business tools.

Preflight now has a separate bounded allowance, default60/account and240/service
per60seconds. Work remains20/account and80/service. Authentication, Origin,
managed execution and shared run concurrency checks are unchanged. Cancellation
is still available while either budget is saturated.429 identifies the budget.

`preflight-budget-before.json` fails on the prior implementation;
`preflight-budget-after.json` passes after the fix. Full Eval regression is526
passed,0 failed (`preflight-budget-full.json`). TypeScript and full build pass;
the existing Vite chunk-size warning remains. Builder's45 focused fixture,
cohort and snapshot-capacity tests pass (`account-managed-fixture-tests.xml`).

## Failed attempts retained

- r1: isolated Python lacked the already-declared rfc8785 dependency; no runtime
  acceptance claimed. Installed the declared dependency in that environment.
- r2: probe initialized the seed before copying its catalog. Corrected the
  fixture order; no model calls and all owned processes reclaimed.
- r3: actual preflight/work-limit regression after32 native executions. All six
  curated entries and upload passed, but migration start returned429. The whole
  run remains failed. All three profiles and simulator reclaimed.
- r4: all six prebuilt entries/28 native executions passed, then the synthetic
  ingress route handler was disposed during browser teardown. Await in-flight
  handlers before closing the browser; do not ignore active request errors.
  All three profiles and simulator reclaimed;88 model pairs were complete.

## Reproduction and interpretation

Use the existing Builder engineering entry point, with an isolated local
configuration containing qualified fixture/artifact paths, not production state:

```sh
python engineering/verify_managed_profile_workspace.py \
  --configuration /absolute/managed-profiles-current-control.json \
  --output /absolute/new-evidence-directory --account-workspaces
```

The script separately initializes the operator seed, then uses ordinary-account
APIs and browser actions. Another account must receive404 on each run and export.
It verifies per-case sessions, tools and source facts, installed versions,
actual snapshot files/history references, and owned process cleanup.

The ingress is synthetic. Migration analysis is a controlled explicit-declaration
analyzer; original cases are deliberately fixed, not freshly model-generated.
Judge returns INDETERMINATE. Neither browser completion nor tool evidence is a
real SSO, live migration analysis, professional-quality or holdout acceptance.
Those release gates remain separate. This report does not authorize relabeling
previous failures, merging drafts or claiming a public-entry switch.
