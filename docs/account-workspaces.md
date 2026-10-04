# Linggan account workspaces (candidate)

## Product policy

All authenticated Linggan accounts may use the entry. No administrator role is
required. Authentication is still required; this is not anonymous upload or
execution. Each account has its own uploaded Skills, migrations and run history.
Repository examples are common read-only content. Operator-reviewed initial
Skills, preparations and Runtime environments are copied into new workspaces.
There is no team-sharing or delegation feature in this change.

## Trusted ingress

The existing SSO gateway must verify the Linggan session, remove client identity
headers and write a stable `x-demo-user: studio_<subject>` plus a server-only
Bearer credential. Do not accept a browser-selected subject, email or role.
Backend access must remain private/loopback; users never enter this credential.
Both the gateway credential and subject are checked on every account API request.
Mutations require the configured HTTPS Origin. Health exposes no account data.

Account dispatch forwards the original HTTP stream to the existing service, so
ZIP upload and SSE remain the same APIs. Stores and in-memory caches are scoped
to one subject. Changing an ID in a URL cannot select another subject's store.
Logging into Linggan does not grant bank permissions or bypass Launcher admission.

## Optional configuration

Default `FINANCE_EVAL_WORKSPACE_MODE=single` preserves existing behavior.
To enable the candidate account entry in an isolated release:

```text
FINANCE_EVAL_WORKSPACE_MODE=account
FINANCE_EVAL_WORKSPACE_ORIGIN=https://finance-eval.demo.linggan.top
FINANCE_EVAL_WORKSPACE_SUBJECT=<verified owner of the old private directory>
FINANCE_EVAL_WORKSPACE_SEED_DIRECTORY=<operator-reviewed seed directory>
FINANCE_EVAL_WORKSPACE_SEED_SHA256=<canonical manifest sha256>
FINANCE_EVAL_WORKSPACE_MAX_ACCOUNTS=64
```

Keep the existing server-only access credential configured. Account mode refuses
public-demo mode, missing credentials or invalid origins. `WORKSPACE_SUBJECT` is
only the old directory's owner in account mode, not an allowlist or privilege.
If there is no old private workspace, omit it. Never reassign a populated old
directory to another account. Do not run multiple service processes on one data
directory.

New accounts use `DATA_DIR/account-workspaces/<sha256(subject)>`. Initial creation
uses a staging directory and rename; existing account content is not overwritten
when a seed changes. A stale `.initializing-*` directory after a crash fails
closed; inspect it offline before retrying, rather than deleting user data.

## Reviewed seed

Build the seed in a clean temporary workspace using the existing asset import,
case preparation and environment setup procedures. Review every included file;
never recursively copy the old owner's data directory. Only `skills/`,
`preparations/` and `environments/` are allowed at the root. Runs, migrations,
tokens, connection secrets and customer documents are not shared seed content.
Environment entries may reference server-managed credential names, not secrets.

Generate and verify the manifest after `pnpm build:core`:

```sh
node scripts/workspace-seed-manifest.mjs /absolute/reviewed/seed
```

The digest covers a recursively name-sorted JSON array of `{path,sha256}` entries;
paths are relative POSIX paths. Startup checks the same digest and refuses
symlinks, special files, files over 8 MiB, totals over 32 MiB or over 2,000 files.
The startup snapshot is used for new accounts; editing the source seed does not
silently change a running service. Preserve the manifest with release evidence.

## Managed execution and capacity

Accounts select approved environments, but cannot register arbitrary URLs or
server credential names through the environment APIs. Direct uploaded script/MCP
execution and arbitrary original-service connections are rejected. Static Skill
inspection, migration and native-tool binding remain available; unknown tools
still need managed admission. These controls are enforced in the service, not
only by hiding buttons.

All account evaluation jobs share `FINANCE_EVAL_MAX_CONCURRENT_RUNS` (1-4), with a
FIFO queue and cancellation of waiting jobs. Closing the service cancels tracked
jobs and waits for cleanup. This is not a general per-user cost quota: analysis
and migration-generation requests still need ingress rate/budget controls before
broad access. Do not promise unlimited usage or unlimited accounts.

The workspace process cache is bounded to `WORKSPACE_MAX_ACCOUNTS` (1-256,
default 64); excess distinct accounts receive `WORKSPACE_CAPACITY_REACHED` until
capacity is adjusted or the process is safely restarted. There is no eviction
that could orphan active runs. Storage retention remains the existing policy;
account mode does not delete old data or add an automatic cleanup quota.

## Verification and rollout gates

```sh
pnpm check
pnpm exec vitest run tests/account-workspaces.test.ts tests/workspace-ingress.test.ts tests/evaluation-run-budget.test.ts
pnpm build
node scripts/verify-account-workspaces-ui.mjs
```

Controlled tests cover two ordinary subjects, unauthorized/spoofed requests,
cross-origin writes, actual ZIP/SSE transport, cross-account run and migration
access, restart persistence, seed integrity and preserved old-owner data. UI
verification uses a synthetic ingress; it is not proof of a real SSO session.

The existing `scripts/verify-launcher-ui.mjs` also accepts
`LAUNCHER_ACCOUNT_WORKSPACES=true` with its prebuilt native fixture. It creates a
reviewed synthetic seed, submits the same frozen two-Runtime configuration from
two separate account stores, and checks distinct instances/sessions, Skill and
model metadata, file closure, Lock/history references and cross-account denial.
Builder's `engineering/verify_balance_native_browser.py --runtime-pair
--account-workspaces` drives this probe and reclaims the isolated bank and Hosts.
Its controlled Judge remains indeterminate; a completed job is not a professional
quality pass. See `account-native-acceptance-20261004.md` for the recorded scope.

Before changing the public entry, verify real Linggan login with two accounts,
trusted header replacement and direct-backend refusal; review the shared seed,
resource limits and migration route policy; then rerun the native dual-Runtime
flow. The existing real-model quality gates are independent and remain in force.

Back up configuration and point the gateway to a separate candidate first.
Rollback restores the previous release/config and gateway target, without
deleting the `account-workspaces` directory or overwriting data created after
release. Do not roll back to a shared private directory while leaving all-account
ingress enabled. This document and code do not mean production has been switched.
