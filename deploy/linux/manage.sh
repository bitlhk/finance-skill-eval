#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/opt/finance-skill-eval
config=/etc/finance-skill-eval
data=/var/lib/finance-skill-eval/data
command=${1:-help}
script_root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
node_bin=$(command -v node)
[[ "$node_bin" =~ ^/[a-zA-Z0-9_./-]+$ ]] || { echo 'Use a system-wide Node installation.' >&2; exit 1; }
require_root() { [[ $EUID -eq 0 ]] || { echo 'Run this operation with sudo.' >&2; exit 1; }; }
release_path() {
  local target
  target=$(realpath -e -- "$1")
  [[ "$target" =~ ^/opt/finance-skill-eval/releases/[a-zA-Z0-9_.-]+$ ]] || { echo 'Release must be a direct child of /opt/finance-skill-eval/releases.' >&2; exit 1; }
  [[ -f "$target/dist/service/server.js" && -x "$target/.venv-openjiuwen/bin/python" ]] || { echo 'Prepare the release first.' >&2; exit 1; }
  printf '%s' "$target"
}
switch_release() {
  ln -s -- "$1" "$base/.current-$$"
  mv -Tf -- "$base/.current-$$" "$base/current"
}
health() { "$node_bin" "$base/current/deploy/health.mjs" --env "$config/production.env"; }
start() {
  systemctl start finance-eval-runtime.service finance-eval-api.service
  for ((i=0;i<45;i++)); do if health >/dev/null 2>&1; then health; return; fi; sleep 2; done
  echo 'Health check failed; inspect journalctl.' >&2; return 1
}
stop() { systemctl stop finance-eval-api.service; systemctl stop finance-eval-runtime.service; }
case "$command" in
  install)
    require_root
    target=$(release_path "${2:?Usage: manage.sh install RELEASE_DIRECTORY}")
    [[ ! -e "$base/current" && ! -L "$base/current" ]] || { echo 'Already installed; use upgrade.' >&2; exit 1; }
    getent group finance-eval >/dev/null || groupadd --system finance-eval
    id finance-eval >/dev/null 2>&1 || useradd --system --gid finance-eval --home-dir /var/lib/finance-skill-eval --shell /usr/sbin/nologin finance-eval
    install -d -m 0755 "$base" "$base/releases"
    chown -R root:finance-eval "$target"
    chmod -R g+rX "$target"
    install -d -m 0750 -o finance-eval -g finance-eval /var/lib/finance-skill-eval "$data" /var/cache/finance-skill-eval
    install -d -m 0750 -o root -g finance-eval "$config"
    [[ -f "$config/production.env" ]] || install -m 0640 -o root -g finance-eval "$script_root/deploy/examples/production.env" "$config/production.env"
    [[ -f "$config/runtime.json" ]] || install -m 0640 -o root -g finance-eval "$script_root/.runtime.local.example.json" "$config/runtime.json"
    for service in api runtime; do
      sed "s|@NODE@|$node_bin|g" "$script_root/deploy/linux/finance-eval-$service.service.in" > "/etc/systemd/system/finance-eval-$service.service"
    done
    switch_release "$target"
    systemctl daemon-reload
    systemctl enable finance-eval-api.service finance-eval-runtime.service
    echo 'Installed but not started. Fill /etc/finance-skill-eval configuration, then run preflight and start.'
    ;;
  preflight) require_root; runuser -u finance-eval -- "$node_bin" "$base/current/deploy/preflight.mjs" --env "$config/production.env" ;;
  start) require_root; start ;;
  stop) require_root; stop ;;
  status) systemctl --no-pager status finance-eval-api.service finance-eval-runtime.service ;;
  logs) journalctl -u finance-eval-api -u finance-eval-runtime --since '1 hour ago' --no-pager ;;
  health) require_root; health ;;
  backup)
    require_root
    systemctl is-active --quiet finance-eval-api && { echo 'Stop services before offline backup.' >&2; exit 1; }
    systemctl is-active --quiet finance-eval-runtime && { echo 'Stop services before offline backup.' >&2; exit 1; }
    python3 "$script_root/deploy/backup.py" create --data "$data" --config "$config" --archive "${2:?Archive path required}"
    ;;
  restore)
    require_root
    python3 "$script_root/deploy/backup.py" restore --archive "${2:?Archive required}" --destination "${3:?New empty destination required}"
    echo 'Verified files restored separately. Review ownership and replace live data/config only while services are stopped.'
    ;;
  upgrade|rollback)
    require_root
    target=$(release_path "${2:?Explicit target release required}")
    old=$(readlink -f "$base/current")
    [[ "$old" != "$target" ]] || { echo 'Already using target release.'; exit 0; }
    chown -R root:finance-eval "$target"
    chmod -R g+rX "$target"
    runuser -u finance-eval -- "$node_bin" "$target/deploy/preflight.mjs" --env "$config/production.env"
    stop
    install -d -m 0700 "$base/backups"
    python3 "$script_root/deploy/backup.py" create --data "$data" --config "$config" --archive "$base/backups/$(date -u +%Y%m%dT%H%M%SZ)-$$.zip"
    switch_release "$target"
    if start; then echo 'Release activated. Run the real-model acceptance before reopening traffic.';
    else
      stop || true
      switch_release "$old"
      echo 'Health failed. Previous code selected, services remain stopped. Restore backup if the new version wrote incompatible data, then start.' >&2
      exit 1
    fi
    ;;
  *) echo 'Usage: manage.sh install RELEASE | preflight | start | stop | status | logs | health | backup ZIP | restore ZIP EMPTY_DIR | upgrade RELEASE | rollback RELEASE' ;;
esac
