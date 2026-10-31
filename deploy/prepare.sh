#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
command -v node >/dev/null
command -v pnpm >/dev/null
command -v uv >/dev/null
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)'
expected=$(node -p 'require("./package.json").packageManager.split("@")[1]')
[[ "$(pnpm --version)" == "$expected" ]] || { echo 'Install the pnpm version specified in package.json.' >&2; exit 1; }
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm build
UV_PYTHON_DOWNLOADS=never UV_PROJECT_ENVIRONMENT="$PWD/.venv-openjiuwen" uv sync --locked --project integrations/openjiuwen --python "${FINANCE_OPENJIUWEN_PYTHON:-python3.12}" --no-dev
printf '%s\n' 'Project prepared in place. Configure .env.local, then run deployment preflight.'
