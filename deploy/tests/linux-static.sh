#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
bash -n deploy/prepare.sh deploy/linux/manage.sh deploy/docker/manage.sh
directory=$(mktemp -d /tmp/finance-unit-XXXXXX)
cleanup() {
  case "$directory" in /tmp/finance-unit-*) rm -rf -- "$directory" ;; *) return 1 ;; esac
}
trap cleanup EXIT
for service in api runtime; do
  # Validate systemd syntax/relationships without pretending to install Node.
  sed 's|@NODE@|/usr/bin/true|g' "deploy/linux/finance-eval-$service.service.in" > "$directory/finance-eval-$service.service"
done
systemd-analyze verify "$directory/finance-eval-api.service" "$directory/finance-eval-runtime.service"
cp deploy/examples/production.env "$directory/production.env"
cp .runtime.local.example.json "$directory/runtime.json"
FINANCE_EVAL_IMAGE=finance-skill-eval:static-validation FINANCE_EVAL_CONFIG_DIR="$directory" docker compose -f deploy/docker/compose.yaml config --quiet
python3 -m unittest discover -s deploy/tests -v
python3 -m unittest integrations.openjiuwen.test_session_process integrations.openjiuwen.test_script_process -v
echo 'PASS Bash, systemd syntax, Compose schema, backup and POSIX descendant cleanup. Host service installation NOT_TESTED.'
