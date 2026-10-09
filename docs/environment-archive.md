# Execution environment archive

An environment registration can be archived without deleting its configuration or
historical runs. This is a lifecycle flag, not a name convention. Records written
before this flag existed are treated as active; reads do not rewrite them.

- `PATCH /api/environments/:id/archive` with `{ "archived": true }` archives it.
- The same endpoint with `false` explicitly restores it.
- `GET /api/environments` lists active registrations.
- `GET /api/environments?includeArchived=true` includes archived registrations.
- `GET /api/environments/:id` remains available for historical references.

These routes use the existing authenticated workspace boundary. Catalog management
retains archived records, while ordinary runtime selectors exclude them. The UI
offers a folded archived list with restore controls.

New runs and retries check current registry state before being queued. Runtime
resolution checks again when queued work starts. An archived launcher or MCP
dependency also blocks its execution environment. Archiving is not cancellation
of an already-running Agent and does not delete its output. Stop/cancel remains
the existing separate lifecycle operation.

Repeated Builder delivery does not revive an archived deployment. Normal edits do
not clear its archive flag, and archived dependent registrations still prevent
deletion of their dependencies. Restoring a registration does not prove that its
endpoint, dependency contracts or runtime qualification are ready; preflight and
execution admission continue to apply.

## Verification

```sh
pnpm test
pnpm check
pnpm build
node scripts/verify-environment-archive-ui.mjs /tmp/environment-archive-ui
```

The browser script uses an isolated temporary registry and does not invoke models
or business tools. Backend tests cover stale snapshots, paired-runtime bindings,
queue admission, retry, dependency archive, history retention and authenticated
access.

## Independent judge verification

An optional live probe grades saved synthetic results without reexecuting tools:

```sh
FINANCE_EVAL_JUDGE_PROVIDER=codex_cli FINANCE_EVAL_JUDGE_MODEL=gpt-6-astra \
  node scripts/verify-codex-judge-live.mjs saved-synthetic-job.json /tmp/judge-probe
```

This requires the existing authenticated Codex CLI. It verifies model grading,
not the quality of every Skill or a fresh end-to-end Agent run. Production model
credentials and saved customer data must not be substituted into this synthetic
probe. Judge configuration is independent of the execution model.
