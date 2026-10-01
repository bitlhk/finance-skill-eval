# Unified migration and Runtime release gates

This checklist supplements the existing migration and Launcher contracts. It does
not introduce a second protocol. HTTP/JSON Launcher remains the integration path.
Only the two managed Java QUERY environments are in scope.

## Browser delivery workflow

- Export requirements for each target, including the target in the download URL
  and filename; inspect the serialized target rather than trusting the filename.
- Register the first delivery, then register the other without restarting the
  migration. The import control must remain available when pending requirements
  become empty. Refresh and verify both independent bindings and result digests.
- Verify failure or expiration on one side does not replace the other side's
  binding or make either appear business-verified.

## Common evidence chain

For each build and evaluation retain references to the immutable Skill digest,
case suite and file digest, requirement and delivery digests, installed assets and
Lock, Runtime version, actual model and generation parameters, build ID, instance
ID, case/run ID, observation reference and cleanup outcome. Prefer existing fields
and immutable references; do not invent evidence for older records.

Both sides use identical input digests but distinct case workspaces and sessions.
Assert actual tool reads, not merely successful file writes. Include traversal,
symlinks, limits, content drift, cross-case reads, failure, timeout and cancellation.
Cancellation requested and cancellation effective are separate events. Cleanup
must be checked in every terminal path, including incomplete builds.

## Repeatable acceptance

1. Controlled data and model: deterministic assertions on the full flow, isolated
   fault injection and cleanup. Record fixture mode explicitly.
2. Real managed model and synthetic bank: browser upload, analysis/migration,
   two target builds, same cases, tool results, evidence, rubric and cleanup.
   A nonempty answer or successful job status is not sufficient.
3. Identity: map the specified administrator to a trusted SSO subject. Verify a
   second authenticated subject cannot read assets, records, downloads or APIs;
   also reject spoofed forwarded headers at untrusted ingress. Never use a
   browser-supplied email as authorization.

Report the three results separately. Passing interface tests and native probes
separately does not prove end-to-end completion. Keep Issue #38 open and the PR
unreleased until these gates pass. Preserve existing data and rollback releases.

Automated development verification is not independent human acceptance.
