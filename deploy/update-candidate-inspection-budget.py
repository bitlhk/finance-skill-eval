"""CAS-protected candidate-only Nginx budget update; no credentials are printed."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile


def digest(data):
    return hashlib.sha256(data).hexdigest()


def render(data):
    text = data.decode('utf-8')
    locations = re.findall(r'^\s*location\s+(?:=|\^~)\s+(\S+)\s*\{', text, re.M)
    if (not locations or len(locations) != len(re.findall(r'^\s*location\b', text, re.M))
            or any(name not in {'/release-check', '/release-check/api/', '/release-check/'} for name in locations)):
        raise ValueError('NOT_CANDIDATE_ONLY_FRAGMENT')
    if len(re.findall(r'\bproxy_read_timeout\s+600s\s*;', text)) != 1:
        raise ValueError('EXPECTED_SINGLE_600_SECOND_DIRECTIVE')
    return re.sub(r'\bproxy_read_timeout\s+600s\s*;', 'proxy_read_timeout 950s;', text).encode()


def replace(path, expected, new):
    if path.read_bytes() != expected:
        raise RuntimeError('CONFIGURATION_CHANGED')
    mode = path.stat().st_mode & 0o777
    fd, name = tempfile.mkstemp(prefix='.eval-budget-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchmod(stream.fileno(), mode)
            stream.write(new); stream.flush(); os.fsync(stream.fileno())
        if path.read_bytes() != expected:
            raise RuntimeError('CONFIGURATION_CHANGED')
        os.replace(name, path)
    finally:
        if os.path.exists(name): os.unlink(name)


def run(command):
    result = subprocess.run(command, capture_output=True, timeout=30)
    if result.returncode:
        # Nginx diagnostics can include private configuration; retain only status.
        raise RuntimeError('CONFIG_CHECK_OR_RELOAD_FAILED')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=['origin', 'gateway'], required=True)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.target == 'gateway':
        path = Path('/etc/nginx/finance-eval-release-check.conf')
        check = ['/usr/sbin/nginx', '-t']
        reload = ['systemctl', 'reload', 'nginx']
    else:
        path = Path('/home/ubuntu/finance-eval-private/releases/20261001-unified-2f82dd74/config/release-check-origin.conf')
        check = ['/usr/sbin/nginx', '-t', '-p', '/home/ubuntu/finance-skill-eval/.public-demo/origin/',
                 '-c', '/home/ubuntu/finance-skill-eval/deploy/finance-eval-origin.nginx.conf']
        reload = ['systemctl', '--user', 'reload', 'finance-eval-origin']
    if path.is_symlink(): raise RuntimeError('CONFIGURATION_SYMLINK_NOT_ALLOWED')
    before = path.read_bytes(); after = render(before)
    receipt = {'target': args.target, 'beforeSha256': digest(before), 'afterSha256': digest(after),
               'status': 'PLANNED', 'rootSwitched': False, 'applicationUpgraded': False}
    if args.apply:
        if args.expected_sha256 != digest(before): raise RuntimeError('BASELINE_DIGEST_REQUIRED')
        run(check)
        backup = path.with_name(path.name + '.before-analysis-budget-' + digest(before)[:16])
        with os.fdopen(os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'wb') as stream:
            stream.write(before); stream.flush(); os.fsync(stream.fileno())
        replace(path, before, after)
        try:
            run(check); run(reload)
        except Exception:
            replace(path, after, before); run(check); run(reload)
            raise
        receipt.update(status='CANDIDATE_BUDGET_UPDATED', backup=str(backup))
    print(json.dumps(receipt))


if __name__ == '__main__': main()
