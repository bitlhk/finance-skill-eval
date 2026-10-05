# Formal Entry Promotion

Platform acceptance and Skill quality are separate. A retained automated quality
FAIL is not itself a platform release blocker. Incorrect input projection,
missing required evidence, mis-scoring, authorization or lifecycle defects remain
platform issues. Never relabel or remove failed answers to obtain release approval.

`deploy/promote-formal-entry.py` updates only the existing Eval virtual host and
dedicated origin. It leaves legacy services, data, candidate routes and old Agents
intact. No data snapshot is restored by promotion or rollback.

## Before Applying

- Verify the pinned candidate, CI, account isolation and actual login evidence.
  Synthetic trusted-ingress tests do not prove ordinary Linggan SSO.
- Place a root-built Vite artifact in a new child of `<release>/web/`. Do not reuse
  `/release-check/`-prefixed output. Verify its digest and readonly browser paths.
- The gateway root API inherited a 64KiB limit and 600-second read timeout; the
  origin inherited 2MiB and 600 seconds. Both hops must match the candidate's
  8MiB API body limit and 950-second analysis budget. Existing auth stays intact.
- Plan both targets without `--apply`. Record hashes privately; do not print
  full Nginx configuration or credentials. The origin reads its existing private
  ingress credential and verifies account-mode health and fail-closed access.
- Apply the gateway budgets first (no target change), then the origin root
  static/API change with each exact `--expected-sha256`. An unexpected baseline
  is a stop, not permission to overwrite concurrent work.

```sh
python3 deploy/promote-formal-entry.py --target gateway --receipt /private/gateway-plan.json
python3 deploy/promote-formal-entry.py --target origin \
  --release /home/ubuntu/finance-eval-private/releases/RELEASE \
  --web /home/ubuntu/finance-eval-private/releases/RELEASE/web/formal \
  --receipt /private/origin-plan.json
```

Apply repeats these arguments with `--apply --expected-sha256 HASH` and a fresh
receipt path. The tool saves a mode-0600 backup, syntax-checks and gracefully
reloads. On validation/reload failure it restores configuration only if there is
no concurrent change. Neither planning nor apply is a genuine-SSO claim.

## After Applying

Verify public health identifies account mode, anonymous and forged identities are
denied, ordinary Linggan login works without a second token, and owner isolation
holds. Open the three Skill paths, dual-runtime selection, retained report and
export at desktop/mobile widths. Do not rerun financial operations to manufacture
history. Record exact server/static/Builder/Harness/projection versions separately.

Old shared-root data remains in the old service; it is not automatically copied
into every user's private account workspace. Candidate account data continues in
the same storage. Legacy `/runtime/` and `/migration/` routes remain unchanged.

For rollback, use `--rollback APPLIED_RECEIPT --expected-sha256 CURRENT_AFTER_HASH
--apply --receipt NEW_RECEIPT` with the matching target. Roll back origin before
gateway. A changed config or backup digest blocks rollback. Preserve all writes
made after promotion. Retained quality failures and incomplete historical traces
remain honest and do not become passing evidence after a route change.
