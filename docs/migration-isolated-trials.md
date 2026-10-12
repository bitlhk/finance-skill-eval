# Account workspace tool trials

Managed accounts can run generated MCP and Script tools in disposable containers.
The operator configures the executor once; there is no per-project approval list.
Authentication, account stores, candidate version checks, environment-registration
restrictions, and managed business-evaluation policy remain in force.

## Configure the executor

Build from the same clean release as the API, with Linux dependencies installed:

```sh
pnpm install --frozen-lockfile
pnpm build:core
docker build -f deploy/Dockerfile.migration-sandbox -t finance-migration-sandbox .
docker image inspect finance-migration-sandbox --format '{{.Id}}'
```

Set `FINANCE_EVAL_MIGRATION_SANDBOX_JSON` on the API to the immutable image ID
returned above, then restart it:

```json
{"image":"sha256:<64 hexadecimal characters>","network":"none","timeoutMs":480000,"maxConcurrent":1}
```

The Docker CLI and a Linux Docker daemon must be available to the API. Prefer a
dedicated worker daemon/VM (configured through Docker's operator-owned connection
settings); the Docker control plane is privileged and must not be given to users
or mounted into trial containers. A missing image or daemon fails the trial;
there is no fallback to execution on the API host. Images are never pulled during
a request. Bake additional Java/build toolchains into the operator image if needed.

Without this configuration, the catalog marks tool trials unavailable, the UI
disables their buttons and explains that an executor must be configured, and the
API returns `503 MIGRATION_SANDBOX_REQUIRED` rather than a misleading approval error.

## Isolation and business connectivity

Each trial runs as UID 1000 with a read-only filesystem, no Linux capabilities,
no privilege escalation, a 512 MiB disposable `/tmp`, 768 MiB memory, one CPU,
128 PIDs and an overall deadline. No host directories, sockets, platform
credentials, account data, or host environment variables are passed in. Only the
selected package and its per-project test input/configuration enter over stdin.
There are no published MCP ports: protocol validation happens inside the container.
The container is removed after completion, timeout or cancellation. Concurrency
is shared across accounts within an API process.

`network: "none"` is the default and supports self-contained tools. To test
procurement against an external business API, provision a **dedicated,
egress-filtered Docker network on the worker** and put its name in `network`.
Permit the business API and any required package repositories, but deny worker/API
hosts, other accounts, private service ranges and cloud metadata. Network names
alone do not implement an egress firewall: enforce it on the worker before
enabling that network. `host`, `bridge`, `default`, and `container:…` are rejected.
Users cannot select a network/image, publish ports, mount volumes, or connect an
arbitrary external MCP endpoint through this interface.

Use the normal runtime dependency fields for the business URL, authorization
header, and department rules. These values are not image/environment configuration
for the API and are not placed in the Docker command line.

## Verification

Run the account-workspace and container-validator regression tests. On a Docker
worker, also run `FINANCE_EVAL_TEST_SANDBOX_IMAGE=sha256:… pnpm exec vitest run
tests/container-migration-validator.test.ts`: the opt-in test executes a Node
Script in a real container, verifies it cannot write the image filesystem or see
a host sentinel, and checks that its container is removed. Run business MCP tests
against the worker's filtered network before releasing the deployment.

This changes tool technical trials only. Existing managed Launcher-based business
evaluation and its restrictions are not removed by enabling the executor.
