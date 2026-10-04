# Managed Eval evidence capacity

This is an operator check, not a new monitoring platform or automatic cleanup.
Use `scripts/check-managed-release-capacity.py` for a managed release containing
`release.json`, per-profile environment files and the pinned Builder capacity
checker. It verifies environment file digests before using their configured
limits; drift or unavailable storage is an error, not a healthy reading.

```sh
python3 scripts/check-managed-release-capacity.py \
  --release /absolute/path/to/managed-release \
  --checker-sha256 <reviewed-Builder-checker-file-sha256>
```

The checker reads configuration and file metadata, never model body contents,
tokens or customer payloads. It invokes the existing Builder capacity checker,
not a second implementation of snapshot retention. Exit codes:

| Code | Meaning | Action |
| --- | --- | --- |
| 0 | All inspected profiles below warning thresholds | Not a reservation for the next build |
| 1 | 80% body count/bytes warning, full quota, or less than 5 GiB free | Stop scheduling extra batches; review capacity |
| 2 | Could not verify configuration or inspect a profile | Investigate before approving more work |

Keep the monitoring script and Builder checker pinned. Run every five minutes
and before/after large evaluation batches. Send output to the private service
journal; a failed oneshot is a local operator alarm, not proof that someone has
received a notification. Do not expose the journal as an anonymous endpoint.
The maintenance operator owns checking alarms; no team on-call service is implied.

## Current candidate budget (2026-10-05)

- Three source profiles (bank, curated, method), each with a shared internal
  Launcher owner, 512 snapshot body files and 64 MiB per owner.
- One Eval job at a time. Both Runtime sides use fresh per-case sessions.
  Limits are shared by all account workspaces through their managed Launcher;
  enabling 64 account workspaces does not multiply this budget by 64.
- No automatic expiry (`FH_SNAPSHOT_RETENTION_SECONDS=0`). This avoids unapproved
  deletion but is not indefinite capacity. The current largest profile has210
  bodies: 41% of its file limit. Measure, do not assume a constant number of model
  calls per case. Six case executions in the recent migration run used24 bodies.
- Five-minute scans and batch checks reduce blind spots; they do not reserve
  storage or eliminate a race with a new write. REQUIRED observation admission
  and write failure reporting remain authoritative.

## Retention and response

Do not change old missing-body states, delete Lock/history metadata to free body
quota, or turn off REQUIRED observation. At warning/full state, preserve running
jobs and evidence, stop adding batches, inventory owner/profile usage, and agree
an archive/retention action. Confirm backups and restoration before any authorized
deletion. This release does not automatically delete, extend quotas or retry
failed banking/model work.

Read-only rollback: disable the capacity timer/oneshot and remove its deployment
files. It changes no application configuration or persisted business data.
Formal-entry replacement still requires genuine ordinary-account SSO, lifecycle,
real-model and browser evidence, plus review; capacity health alone is not release
approval.
