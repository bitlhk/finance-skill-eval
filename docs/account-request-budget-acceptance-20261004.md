# Account request-budget acceptance

This records the initial limiter acceptance at59af867. The full native account
cohort subsequently exposed preflight requests consuming work slots. Current
behavior separates bounded preflight admission; see `account-workspaces.md`.
The original counts and reports below are historical, not final release proof.

This closes the unbounded ingress-request gap introduced by opening workspaces
to ordinary authenticated Linggan accounts. It does not introduce an account
role, monetary quota service, new Runtime or new execution protocol.

## Behavior

- Account mode only: shared rolling admission counts default to20 per account
  and80 per service per60seconds. Deployment can set bounded explicit values.
- All API mutations count, except run cancellation and existing optimization
  decisions. Migration diagnosis/inspection/report/export reads count because
  those legacy routes may initialize missing model-assisted diagnostics.
- Over-limit requests return429 before the account child handler, with scope,
  retry seconds, Retry-After and a Chinese wait message. Authenticated identity
  is taken only from the existing trusted ingress. Unauthorized requests do not
  consume slots. Rejection does not extend the window.
- Run history and cancellation remain usable under saturation. Existing work
  and assets are not deleted, restarted or silently retried.
- Limits are local to one process and reset on restart. They do not count every
  underlying model call, charge, token or background task. Provider-side monetary
  caps and existing evaluation concurrency remain separate deployment controls.

## Evidence

Local evidence directory: `/home/ubuntu/outputs/eval-formal-entry-release`.

- `request-budget-before.json`: new limiter tests fail before implementation.
- `request-budget-after.json`: rolling-window, scope, route, cancellation and
  invalid-config unit checks pass.
- `account-budget-focused.json`:39 tests pass, including child-handler call
  counters proving rejected requests do not enter the downstream route.
- `account-budget-full.json`:524 full Eval tests pass,0 failures.
- `pnpm check` and `pnpm build`:pass.
- `account-budget-ui-r1/report.json`:two synthetic accounts;1366/390/320px,
  upload, isolation, reload and visible429 message pass. Existing asset retained.
  Screenshot `request-budget-message.png` inspected at320px.

Browser uses a synthetic trusted ingress. This is not real Linggan SSO, a real
model run, a professional quality review or a deployment. The earlier native
two-account four-execution evidence remains documented separately. No public
service, gateway, existing data or old Agent was changed by these checks.
