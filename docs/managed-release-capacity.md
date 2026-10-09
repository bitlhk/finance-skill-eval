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

The checker reads configuration, file metadata and bounded request headers (at
most 16 KiB per journal). It never reads event rows, model body contents or lock
contents. It invokes the Builder checker, not a second implementation of
retention. Request-header values other than the reservation are not output.
Exit codes:

| Code | Meaning | Action |
| --- | --- | --- |
| 0 | All inspected profiles below warning thresholds | Not a reservation for the next build |
| 1 | 80% body or archive warning, next archive reservation unavailable, unknown legacy header, or less than 5 GiB free | Stop scheduling extra batches; review capacity |
| 2 | Could not verify configuration or inspect a profile | Investigate before approving more work |

Keep the monitoring script and Builder checker pinned. Run every five minutes
and before/after large evaluation batches. Send output to the private service
journal; a failed oneshot is a local operator alarm, not proof that someone has
received a notification. Do not expose the journal as an anonymous endpoint.
The maintenance operator owns checking alarms; no team on-call service is implied.
The optional `--checker-relative` selects a digest-pinned helper inside a release
amendment directory, allowing a read-only monitor update without replacing the
generated Host. Absolute paths, parent traversal and symlinks are rejected. The
default is the embedded Builder checker; old snapshot-only checkers cannot
silently satisfy the expanded monitoring contract.

## Current candidate budget (2026-10-05)

- Three source profiles (bank, curated, method), each with a shared internal
  Launcher owner, 512 snapshot body files and 64 MiB per owner.
- One Eval job at a time. Both Runtime sides use fresh per-case sessions.
  Limits are shared by all account workspaces through their managed Launcher;
  enabling 64 account workspaces does not multiply this budget by 64.
- No automatic expiry (`FH_SNAPSHOT_RETENTION_SECONDS=0`). This avoids unapproved
  deletion but is not indefinite capacity. Measure, do not assume a constant
  number of model calls per case.
- Initial archive budget was separately 128 MiB, with 1 MiB request and 256 KiB manifest
  limits. The Host conservatively reserves 1,642,496 bytes per request, including
  both manifests, labels and overhead. Completion does not release reservations.
  Actual file bytes alone therefore cannot show whether another request fits.
- The October 5 scan found 81 curated journals reserving 133,042,176 bytes,
  despite only 21,776,631 root-level file bytes. Snapshots were342/512 and healthy;
  archive capacity was FULL. Two later requests lacked archived history. Keep
  their missing states; enlarging a future budget does not repair old records.
- Output separates snapshot and archive alarms, counts legacy/unknown headers,
  and reports the next request reservation and remaining reservations. Unknown
  headers use the Host's conservative maximum and produce a warning. Limits on
  files/journals produce UNAVAILABLE rather than an incomplete healthy count.
- A budget increase requires explicit bounded configuration and the existing
  exact-configuration qualification. This monitor never changes quotas or turns
  off admission. Do not multiply these budgets by the account count.

### Candidate amendment, 2026-10-05

After controlled generated-host checks on both Java Runtimes, the curated
profile alone now has a256MiB archive budget. Bank and method-only profiles
remain128MiB. Request/manifest limits,512snapshot files,64MiB snapshot bytes,
owner isolation and retention are unchanged. The read-only capacity monitor
uses each profile's digest-locked settings; it does not assume this larger
limit for other deployments.

The amendment preserves all81old curated journals and their reservations,
leaving82new request reservations at the initial post-amendment scan. Snapshot
capacity can become the next constraint; no fixed job count or indefinite
retention is promised. The two previously missing journals remain missing.
New real-model requests must establish storage success separately from the
controlled qualification. This is a candidate change, not formal-entry approval.
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
