# Account workspace candidate acceptance, 2026-10-04

This change follows the user's decision to allow every authenticated Linggan
account, without a designated-administrator requirement. The conservative data
policy is shared approved examples plus isolated personal content. It is an
optional candidate mode, not a statement that the public site has switched.

## Completed

- `pnpm check` and production web/core build passed.
- Full Vitest regression: 496 passed, 0 failed, 90 files.
- Two synthetic ordinary accounts: ZIP upload, individual catalog visibility,
  migration and run-ID isolation, SSE delivery, cancellation denial, persisted
  records after restart, unchanged old-owner records.
- Seed checksum, forbidden private-store roots and symlink refusal; concurrent
  first access does not create duplicate workspaces. Account cache is bounded.
- Shared evaluation queue limits concurrency across accounts; canceled waiting
  jobs do not execute and failures release capacity.
- Browser: actual backend, two synthetic ingress identities, Skill upload and
  reload, other-account isolation, managed environment controls, 1366px desktop
  plus 390px/320px mobile. No page errors or horizontal overflow.
- Initial probes found that unknown migration and cancellation IDs returned
  internal errors. They now return 404 without filesystem paths; failed probe
  reports were retained rather than overwritten as successes.

## Evidence

Local release evidence directory: `/home/ubuntu/outputs/eval-formal-entry-release`.

- `account-workspace-full-r2.json`: full regression and individual results.
- `account-ui-r2/report.json`: browser assertions and limits.
- `account-ui-r2/alice-private-assets-desktop.png`,
  `managed-environments-desktop.png`, `alice-assets-390.png`, `alice-assets-320.png`.

The browser seed intentionally has no live Runtime environment; screenshots do
not prove native-Runtime execution. This round made zero real-model and bank
requests. Existing native/live-model results are separate evidence and must not
be relabeled as multi-account end-to-end acceptance.

## Still required before enabling all-account ingress

Actual Linggan SSO header/cookie integration and two real accounts, an explicitly
reviewed common seed, rate/cost limits for analysis and migration, cross-account
native execution evidence and controlled rollout/rollback. Existing live-model
format/account-selection and wealth/audit case-policy gates remain separate.
See [deployment and rollback](account-workspaces.md).
