#!/usr/bin/env bash
set -euo pipefail
umask 077
script=$(realpath -- "${BASH_SOURCE[0]}")
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
compose=(docker compose -f compose.yaml)
: "${FINANCE_EVAL_IMAGE:?Set FINANCE_EVAL_IMAGE to an immutable version tag}"
: "${FINANCE_EVAL_CONFIG_DIR:?Set FINANCE_EVAL_CONFIG_DIR to an absolute private directory}"
[[ "$FINANCE_EVAL_CONFIG_DIR" == /* ]] || { echo 'Configuration directory must be absolute.' >&2; exit 1; }
case "${1:-help}" in
  build) "${compose[@]}" build ;;
  preflight)
    "${compose[@]}" config --quiet
    "${compose[@]}" run --rm --no-deps api node deploy/preflight.mjs
    ;;
  start) "${compose[@]}" up -d --wait --wait-timeout 180 ;;
  stop) "${compose[@]}" stop -t 75 api; "${compose[@]}" stop -t 75 runtime ;;
  status) "${compose[@]}" ps ;;
  logs) "${compose[@]}" logs --since 1h --tail 500 ;;
  health) "${compose[@]}" exec -T api node deploy/health.mjs --runtime http://runtime:56362 ;;
  backup)
    archive=${2:?Absolute backup archive path required}
    [[ "$archive" == /* && ! -e "$archive" ]] || { echo 'Use a new absolute archive path.' >&2; exit 1; }
    [[ -z "$("${compose[@]}" ps --status running -q)" ]] || { echo 'Stop both services before backup.' >&2; exit 1; }
    mkdir -p -- "$(dirname -- "$archive")"
    "${compose[@]}" run --rm --no-deps --user 0 \
      -v "$FINANCE_EVAL_CONFIG_DIR:/backup-config:ro" -v "$(dirname -- "$archive"):/backup" \
      api python3 deploy/backup.py create --data /app/data --config /backup-config --archive "/backup/$(basename -- "$archive")"
    ;;
  restore)
    archive=${2:?Absolute archive path required}; destination=${3:?Absolute new empty directory required}
    [[ "$archive" == /* && "$destination" == /* && ! -e "$destination" ]] || { echo 'Use absolute paths and a new restore destination.' >&2; exit 1; }
    mkdir -m 0700 -- "$destination"
    "${compose[@]}" run --rm --no-deps --user 0 -v "$archive:/backup/input.zip:ro" -v "$destination:/restore" \
      api python3 deploy/backup.py restore --archive /backup/input.zip --destination /restore
    echo 'Restored separately. Review configuration and copy data to the stopped API volume; never use down -v.'
    ;;
  upgrade|rollback)
    target=${2:?Explicit target image tag or digest required}; archive=${3:?Absolute pre-switch backup archive required}
    FINANCE_EVAL_IMAGE="$target" "${compose[@]}" run --rm --no-deps api node deploy/preflight.mjs
    bash "$script" stop
    bash "$script" backup "$archive"
    if FINANCE_EVAL_IMAGE="$target" "${compose[@]}" up -d --wait --wait-timeout 180; then
      echo 'Target image started. Persist FINANCE_EVAL_IMAGE and run health plus real-model acceptance.'
    else
      FINANCE_EVAL_IMAGE="$target" "${compose[@]}" stop -t 75
      echo 'Activation failed; services stopped and data retained. Select previous image; review data compatibility before restarting.' >&2
      exit 1
    fi
    ;;
  *) echo 'Usage: manage.sh build|preflight|start|stop|status|logs|health|backup ZIP|restore ZIP NEW_DIR|upgrade IMAGE BACKUP_ZIP|rollback IMAGE BACKUP_ZIP' ;;
esac
