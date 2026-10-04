"""Read-only release check using the pinned Builder snapshot-capacity checker.

No body, token or customer payload is read. Output is suitable for a private
systemd journal; exit 1 means capacity warning, exit 2 means unknown/unavailable.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys


CHECKER = 'builder/community/finance/builder/finance-solution-builder/engineering/check_snapshot_capacity.py'


def file_bytes(root, relative):
    file = root / relative
    if not file.is_relative_to(root) or any(p.is_symlink() for p in [file, *file.parents]):
        raise ValueError('UNSAFE_RELEASE_PATH')
    if not file.is_file() or file.stat().st_size > 1024 * 1024:
        raise ValueError('RELEASE_FILE_UNAVAILABLE')
    return file.read_bytes()


def inspect(release, checker_sha256, minimum_free_bytes=5 * 1024**3, runner=subprocess.run,
            disk_usage=shutil.disk_usage):
    if not re.fullmatch(r'[a-f0-9]{64}', checker_sha256) or minimum_free_bytes < 1:
        raise ValueError('INVALID_MONITOR_CONFIGURATION')
    release = Path(release).absolute()
    checker = file_bytes(release, CHECKER)
    if hashlib.sha256(checker).hexdigest() != checker_sha256:
        raise ValueError('CHECKER_DIGEST_MISMATCH')
    manifest_raw = file_bytes(release, 'release.json')
    manifest = json.loads(manifest_raw)
    profiles = manifest['profiles']
    if not isinstance(profiles, dict) or not 1 <= len(profiles) <= 16:
        raise ValueError('PROFILE_LIST_INVALID')
    rows = []
    for name, record in sorted(profiles.items()):
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,63}', name):
            raise ValueError('PROFILE_ID_INVALID')
        raw = file_bytes(release, f'config/{name}/environment.json')
        if hashlib.sha256(raw).hexdigest() != record['environmentSha256']:
            raise ValueError('PROFILE_ENVIRONMENT_CHANGED')
        env = json.loads(raw)
        # Match Builder's defaults; explicit release limits take precedence.
        max_files = int(env.get('FH_SNAPSHOT_MAX_FILES', 128))
        max_bytes = int(env.get('FH_SNAPSHOT_MAX_BYTES', 16777216))
        retention = int(env.get('FH_SNAPSHOT_RETENTION_SECONDS', 0))
        if not 0 <= retention <= 31536000:
            raise ValueError('RETENTION_INVALID')
        history = release / 'state' / name / 'execution-history'
        if not history.is_dir() or any(p.is_symlink() for p in [history, *history.parents]):
            raise ValueError('HISTORY_DIRECTORY_UNAVAILABLE')
        result = runner([sys.executable, '-B', str(release / CHECKER), str(history),
                         '--max-files', str(max_files), '--max-bytes', str(max_bytes)],
                        capture_output=True, text=True, timeout=30)
        if result.returncode not in (0, 1):
            raise ValueError('PROFILE_CAPACITY_UNAVAILABLE')
        report = json.loads(result.stdout)
        if (report.get('scope') != 'OWNER_SNAPSHOT_BODIES'
                or not isinstance(report.get('owners'), list)
                or type(report.get('alert')) is not bool
                or report['alert'] != (result.returncode == 1)):
            raise ValueError('CHECKER_REPORT_INVALID')
        rows.append({'profile': name, 'environmentSha256': record['environmentSha256'],
                     'retentionSeconds': retention, 'owners': report['owners'],
                     'alert': report['alert']})
    free = disk_usage(release).free
    disk_warning = free < minimum_free_bytes
    return {'schemaVersion': 'finance.release-capacity.v1',
            'observedAt': datetime.now(timezone.utc).isoformat(),
            'scope': 'SNAPSHOT_METADATA_AND_FILESYSTEM_FREE_SPACE',
            'releaseSha256': hashlib.sha256(manifest_raw).hexdigest(),
            'versions': manifest['versions'], 'checkerSha256': checker_sha256,
            'profiles': rows, 'diskFreeBytes': free, 'minimumFreeBytes': minimum_free_bytes,
            'alert': disk_warning or any(row['alert'] for row in rows),
            'diskWarning': disk_warning, 'bodiesRead': False, 'historyChanged': False,
            'retentionChanged': False}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', required=True, type=Path)
    parser.add_argument('--checker-sha256', required=True)
    parser.add_argument('--minimum-free-bytes', type=int, default=5 * 1024**3)
    args = parser.parse_args()
    try:
        report = inspect(args.release, args.checker_sha256, args.minimum_free_bytes)
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as error:
        print(json.dumps({'alert': True, 'state': 'UNAVAILABLE', 'errorType': type(error).__name__,
                          'observedAt': datetime.now(timezone.utc).isoformat()}))
        raise SystemExit(2)
    print(json.dumps(report))
    raise SystemExit(1 if report['alert'] else 0)
