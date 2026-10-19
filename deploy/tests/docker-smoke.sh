#!/usr/bin/env bash
# Uses a real built image and private configuration. Creates only disposable
# project volumes. Does not call a model; model behavior is a separate acceptance.
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
: "${FINANCE_EVAL_IMAGE:?Set the image to test}"
: "${FINANCE_EVAL_CONFIG_DIR:?Set private configuration directory}"
original_config=$FINANCE_EVAL_CONFIG_DIR
directory=$(mktemp -d /tmp/finance-docker-audit-XXXXXX)
export COMPOSE_PROJECT_NAME="finance-audit-$(basename "$directory" | tr '[:upper:]' '[:lower:]')"
export FINANCE_EVAL_PUBLISH_PORT
FINANCE_EVAL_PUBLISH_PORT=$(python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",0)); print(s.getsockname()[1]); s.close()')
export FINANCE_EVAL_CONFIG_DIR="$directory/config"
mkdir -m 0700 "$FINANCE_EVAL_CONFIG_DIR"
cp "$original_config/production.env" "$FINANCE_EVAL_CONFIG_DIR/production.env"
cp "$original_config/runtime.json" "$FINANCE_EVAL_CONFIG_DIR/runtime.json"
chmod 0600 "$FINANCE_EVAL_CONFIG_DIR/"*
chown 1000:1000 "$FINANCE_EVAL_CONFIG_DIR/runtime.json"
compose=(docker compose -f deploy/docker/compose.yaml)
upgrade_image="finance-skill-eval:audit-upgrade-${COMPOSE_PROJECT_NAME#finance-audit-}"
cleanup() {
  case "$COMPOSE_PROJECT_NAME" in finance-audit-*) "${compose[@]}" down -v --remove-orphans >/dev/null 2>&1 || true ;; *) return 1 ;; esac
  docker image rm "$upgrade_image" >/dev/null 2>&1 || true
  case "$directory" in /tmp/finance-docker-audit-*) rm -rf -- "$directory" ;; *) return 1 ;; esac
}
trap cleanup EXIT
bash deploy/docker/manage.sh preflight
"${compose[@]}" run --rm --no-deps api /app/.venv-openjiuwen/bin/python -c "from integrations.openjiuwen.operational_logging import configure_sdk_logging; configure_sdk_logging(); from openjiuwen.harness.deep_agent import DeepAgent; from openjiuwen.harness.subagents.code_agent import create_code_agent; print('PASS real Linux Agent SDK imports')"
bash deploy/docker/manage.sh start
bash deploy/docker/manage.sh health
"${compose[@]}" exec -T api node -e "require('fs').writeFileSync('/app/data/deploy-audit-marker','persistent-audit')"
container=$("${compose[@]}" ps -q api)
# Kill only this disposable project's recorded supervisor, allowing restart policy
# to run. This exercises stale state when PID namespaces reuse the old PID.
"${compose[@]}" exec -T api node -e "const s=JSON.parse(require('fs').readFileSync('/app/data/processes/api.json'));process.kill(s.pid,'SIGKILL')" || true
recovered=false
for ((attempt=0;attempt<90;attempt++)); do
  restarts=$(docker inspect --format '{{.RestartCount}}' "$container")
  if [[ "$restarts" -gt 0 ]] && bash deploy/docker/manage.sh health >/dev/null 2>&1; then recovered=true; break; fi
  sleep 2
done
[[ "$recovered" == true ]] || { echo 'FAIL container automatic recovery'; exit 1; }
echo 'PASS real container automatic restart and stale PID recovery'
bash deploy/docker/manage.sh stop
bash deploy/docker/manage.sh backup "$directory/backup.zip"
bash deploy/docker/manage.sh restore "$directory/backup.zip" "$directory/restored"
[[ "$(cat "$directory/restored/data/deploy-audit-marker")" == persistent-audit ]]
cmp "$FINANCE_EVAL_CONFIG_DIR/runtime.json" "$directory/restored/config/runtime.json"
echo 'PASS offline volume backup and separate verified restore'
docker tag "$FINANCE_EVAL_IMAGE" "$upgrade_image"
bash deploy/docker/manage.sh upgrade "$upgrade_image" "$directory/pre-upgrade.zip"
original_image=$FINANCE_EVAL_IMAGE
export FINANCE_EVAL_IMAGE="$upgrade_image"
bash deploy/docker/manage.sh rollback "$original_image" "$directory/pre-rollback.zip"
export FINANCE_EVAL_IMAGE="$original_image"
bash deploy/docker/manage.sh health
"${compose[@]}" exec -T api node -e "if(require('fs').readFileSync('/app/data/deploy-audit-marker','utf8')!=='persistent-audit')process.exit(1)"
bash deploy/docker/manage.sh stop
echo 'PASS Compose start/stop, authentication, multi-skill capabilities, persistence, backup/restore and same-artifact tag upgrade/rollback. Model execution NOT_TESTED.'
