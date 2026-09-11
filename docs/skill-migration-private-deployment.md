# Single-administrator migration workspace

Deployment date: 2026-09-11. This is a private package migration workspace,
not native Runtime migration or business acceptance.

## Deployment boundary

- URL: https://finance-eval.demo.linggan.top/migration/
- Existing remote gateway retains Linggan SSO. No remote gateway configuration
  was changed for this release.
- Local HTTPS origin forwards `/migration/` to loopback port 56402, stripping
  the prefix. The existing public service on port 56371 is unchanged.
- Persistent user unit: `finance-skill-migration-private.service`.
- Separate data: `.migration-workspace/`; no PF customer sample or public
  service data is imported automatically.
- Administrator secret: `.migration-workspace/access-token`, mode 0600.
  Never commit, log, embed in URLs, or include it in downloadable artifacts.
- This is one trusted administrator, not per-user project authorization.

The SSO gateway owns the ordinary Authorization header. The private web build
sends `X-Migration-Authorization`; only the private origin location maps it to
Authorization. The public ingress credential never grants workspace access.
Anonymous page requests at the domain still go to SSO; every private data API
also requires the separate administrator token.

## Build and operate

From the repository root:

```sh
pnpm check
pnpm build:core
VITE_PRIVATE_WORKSPACE=true pnpm exec vite build --base=/migration/ --outDir="$PWD/web-dist-private"
```

Service environment:

```text
MIGRATION_PREVIEW_DATA=<repository>/.migration-workspace
MIGRATION_PREVIEW_PORT=56402
MIGRATION_WEB_DIRECTORY=web-dist-private
```

Start `node scripts/serve-migration-preview.mjs` under the persistent user
service, with `UMask=0077`, `Restart=on-failure`, and loopback binding.
The first start generates the secret. Back up the private directory securely;
do not combine it with public demo storage. Rotate the secret by replacing the
file with a new cryptographically random value, preserving mode 0600, then
restart the private service. Previously stored browser tokens become invalid.

Private origin location (inside the existing restricted HTTPS server):

```nginx
location = /migration { return 302 /migration/; }
location ^~ /migration/ {
    proxy_pass http://127.0.0.1:56402/;
    proxy_http_version 1.1;
    proxy_set_header Authorization $http_x_migration_authorization;
    proxy_set_header X-Migration-Authorization "";
    proxy_set_header Cookie "";
    proxy_set_header Host $http_host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_cache off;
    proxy_read_timeout 600s;
    proxy_send_timeout 600s;
    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
}
```

Keep the origin peer allowlist: remote gateway and local loopback only. Validate
Nginx configuration before reload. Rollback removes only these two locations
and stops the private service; preserve the private data. Public routes do not
need to be restarted. Gateway upload size limits still apply; do not claim large
archives work without checking the remote limit.

## Verification performed

- Type checking and private web build: passed.
- Repository regression: 27 test files, 75 tests passed, zero failures.
- Actual local HTTPS origin: private page and correct base assets returned 200;
  missing token, wrong token and ordinary Authorization-only each returned 401;
  separate administrator header returned 200; public health remained 200.
- Token mode: 0600. APIs and private responses use no-store.
- Private-header browser regression: 11 checks passed against an isolated real
  service and a prefix/header forwarding proxy, including import, immutable
  editing, project suites, draft export, refresh, mobile layout and no JS errors.
- Public domain without SSO: 302 to the existing Linggan login bridge.
- Authenticated end-to-end traversal of the remote SSO gateway: pending a user
  with an existing Linggan session. Local proxy testing does not substitute
  for this check. A gateway that strips custom headers must be adjusted before
  this check can pass; do not fall back to trusting its public ingress token.
- No live model evaluation, customer import, native migration acceptance or
  multi-user isolation was performed as part of this deployment.

Browser regression command:

```sh
MIGRATION_TEST_PREFIX=/migration/ \
MIGRATION_TEST_PRIVATE_GATEWAY=true \
MIGRATION_TEST_WEB_DIR=web-dist-private \
node scripts/verify-migration-ui.mjs reports/private-migration-ui
```

Set `CHROMIUM_PATH` when using an externally installed Playwright browser.
For access, log into Linggan, open the workspace URL, and enter the separate
administrator token. Obtain it from the protected file, not from public docs.
