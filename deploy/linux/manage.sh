#!/usr/bin/env bash
set -euo pipefail
umask 077
command=${1:-help}
project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)
node_bin=$(command -v node)
# These paths are interpolated into systemd units, not shell-evaluated.
for value in "$project" "$node_bin"; do
  [[ "$value" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Use absolute project/Node paths without spaces or special characters.' >&2; exit 1; }
done
require_root() { [[ $EUID -eq 0 ]] || { echo 'Run this operation with sudo.' >&2; exit 1; }; }
health() { "$node_bin" "$project/deploy/health.mjs"; }
start() {
  for service in api runtime; do
    [[ "$(systemctl show "finance-eval-$service.service" --property=WorkingDirectory --value)" == "$project" ]] || {
      echo 'Installed service targets another project. Stop it and run install from this project first.' >&2; return 1
    }
  done
  systemctl start finance-eval-runtime.service finance-eval-api.service
  for ((i=0;i<30;i++)); do if health >/dev/null 2>&1; then health; return; fi; sleep 1; done
  echo 'Health check failed; inspect journalctl.' >&2; return 1
}
stop() { systemctl stop finance-eval-api.service; systemctl stop finance-eval-runtime.service; }
require_stopped() {
  for service in api runtime; do
    state=$(systemctl show "finance-eval-$service.service" --property=ActiveState --value 2>/dev/null || true)
    [[ -z "$state" || "$state" == inactive || "$state" == failed ]] || { echo 'Stop services before reconfiguration or backup.' >&2; exit 1; }
  done
}
case "$command" in
  install)
    require_root
    require_stopped
    [[ -f "$project/.env.local" && -f "$project/dist/service/server.js" ]] || { echo 'Configure project .env.local and build first.' >&2; exit 1; }
    getent group finance-eval >/dev/null || groupadd --system finance-eval
    id finance-eval >/dev/null 2>&1 || useradd --system --gid finance-eval --home-dir /var/lib/finance-skill-eval --shell /usr/sbin/nologin finance-eval
    info=$("$node_bin" "$project/deploy/project.mjs" paths)
    data=$(printf '%s' "$info" | "$node_bin" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).data))')
    runtime=$(printf '%s' "$info" | "$node_bin" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.stdout.write(JSON.parse(s).runtime))')
    install -d -m 0750 -o finance-eval -g finance-eval /var/lib/finance-skill-eval /var/cache/finance-skill-eval
    if [[ ! -d "$data" ]]; then install -d -m 0750 -o finance-eval -g finance-eval "$data"; fi
    chgrp finance-eval "$project/.env.local" "$runtime"
    chmod 0640 "$project/.env.local" "$runtime"
    # Never recursively chown the checkout or shared dependency store.
    runuser -u finance-eval -- "$node_bin" "$project/deploy/preflight.mjs"
    for service in api runtime; do
      sed -e "s|@NODE@|$node_bin|g" -e "s|@PROJECT@|$project|g" "$project/deploy/linux/finance-eval-$service.service.in" > "/etc/systemd/system/finance-eval-$service.service"
    done
    systemctl daemon-reload
    systemctl enable finance-eval-api.service finance-eval-runtime.service
    echo 'Installed against this Git checkout and .env.local; no code or configuration copies created. Run start.'
    ;;
  preflight) require_root; runuser -u finance-eval -- "$node_bin" "$project/deploy/preflight.mjs" ;;
  start) require_root; start ;;
  stop) require_root; stop ;;
  restart) require_root; stop; start ;;
  status) systemctl --no-pager status finance-eval-api.service finance-eval-runtime.service ;;
  logs) journalctl -u finance-eval-api -u finance-eval-runtime --since '1 hour ago' --no-pager ;;
  health) require_root; health ;;
  backup) require_root; require_stopped; "$node_bin" "$project/deploy/project.mjs" backup --archive "${2:?Absolute archive path required}" ;;
  restore)
    require_root
    "$node_bin" "$project/deploy/project.mjs" restore --archive "${2:?Absolute archive required}" --destination "${3:?New empty absolute destination required}"
    echo 'Restored separately. While stopped, restore data to its configured location and config files to the project.'
    ;;
  *) echo 'Usage: manage.sh install | preflight | start | stop | restart | status | logs | health | backup ZIP | restore ZIP EMPTY_DIR. Select versions with Git in this checkout.' >&2; exit 1 ;;
esac
