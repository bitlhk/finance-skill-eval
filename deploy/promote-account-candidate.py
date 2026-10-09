"""Switch only the existing candidate origin to a qualified account-mode release."""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
from urllib.error import HTTPError
from urllib.request import Request, urlopen

spec = importlib.util.spec_from_file_location('candidate_config', Path(__file__).with_name('update-candidate-inspection-budget.py'))
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)
ORIGIN = Path('/home/ubuntu/finance-eval-private/releases/20261001-unified-2f82dd74/config/release-check-origin.conf')
RELEASES = Path('/home/ubuntu/finance-eval-private/releases')
CHECK = ['/usr/sbin/nginx', '-t', '-p', '/home/ubuntu/finance-skill-eval/.public-demo/origin/',
         '-c', '/home/ubuntu/finance-skill-eval/deploy/finance-eval-origin.nginx.conf']
RELOAD = ['systemctl', '--user', 'reload', 'finance-eval-origin']


def render(before, port, web, token):
    text = before.decode()
    # Refuse unexpected routes or directives rather than silently replacing newer work.
    expected = (r'location = /release-check \{ return 302 /release-check/; \}\s*'
                r'location \^~ /release-check/api/ \{[^{}]*\}\s*'
                r'location \^~ /release-check/ \{[^{}]*\}\s*')
    if not re.fullmatch(expected, text):
        raise ValueError('NOT_EXPECTED_CANDIDATE_FRAGMENT')
    substitutions = [
        (r'proxy_pass http://127\.0\.0\.1:\d+/api/;', f'proxy_pass http://127.0.0.1:{port}/api/;'),
        (r'proxy_set_header Authorization "Bearer [A-Za-z0-9._~+/-]+";', f'proxy_set_header Authorization "Bearer {token}";'),
        (r'alias /[A-Za-z0-9_./-]+/;', f'alias {web}/;'),
    ]
    if not isinstance(port, int) or not 1024 <= port <= 65535:
        raise ValueError('INVALID_PORT')
    if not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(web)) or '..' in Path(web).parts:
        raise ValueError('INVALID_STATIC_PATH')
    if not re.fullmatch(r'[A-Za-z0-9._~+/-]{32,256}', token):
        raise ValueError('INVALID_INGRESS_CREDENTIAL')
    for pattern, replacement in substitutions:
        text, count = re.subn(pattern, replacement, text)
        if count != 1:
            raise ValueError('AMBIGUOUS_CANDIDATE_DIRECTIVE')
    for required in ('proxy_set_header X-Demo-User $http_x_demo_user;',
                     'proxy_set_header X-Migration-Authorization "";',
                     'proxy_set_header Cookie "";', 'proxy_read_timeout 950s;'):
        if text.count(required) != 1:
            raise ValueError('INGRESS_BOUNDARY_CHANGED')
    return text.encode()


def preflight(base, token):
    def get(route, headers=None):
        try:
            with urlopen(Request(base + route, headers=headers or {}), timeout=20) as reply:
                return reply.status, json.load(reply)
        except HTTPError as error:
            return error.code, None
    status, health = get('/api/health')
    if status != 200 or health.get('deploymentMode') != 'account-workspaces':
        raise ValueError('ACCOUNT_MODE_NOT_ACTIVE')
    for headers, expected in [({}, 401), ({'x-demo-user': 'studio_candidate_guard'}, 401),
                              ({'authorization': 'Bearer ' + token}, 403)]:
        if get('/api/catalog', headers)[0] != expected:
            raise ValueError('INGRESS_NOT_FAIL_CLOSED')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release', type=Path, required=True)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--receipt', type=Path, required=True)
    args = parser.parse_args()
    release = args.release
    if release.parent != RELEASES or release.is_symlink() or release.resolve() != release:
        raise ValueError('INVALID_RELEASE_DIRECTORY')
    if ORIGIN.is_symlink() or args.receipt.exists():
        raise ValueError('UNSAFE_CONFIG_OR_EXISTING_RECEIPT')
    operations = json.loads((release / 'operations.json').read_text())
    manifest = json.loads((release / 'release.json').read_text())
    if operations['workspaceMode'] != 'account' or operations['productionDataCopied'] is not False:
        raise ValueError('NOT_ISOLATED_ACCOUNT_RELEASE')
    directory = operations.get('evalDirectory', 'eval')
    if not re.fullmatch(r'eval(?:-[a-f0-9]+)?', directory):
        raise ValueError('INVALID_CODE_DIRECTORY')
    checkout = release / directory
    def git(*args):
        return subprocess.check_output(['git', '-C', str(checkout), *args], text=True).strip()
    if git('rev-parse', 'HEAD') != manifest['versions']['eval'] or git('status', '--porcelain'):
        raise ValueError('SOURCE_BASELINE_MISMATCH')
    web = release / 'web/candidate'
    if web.is_symlink() or not (web / 'index.html').is_file():
        raise ValueError('STATIC_BUILD_MISSING')
    credential = release / 'config/ingress-token'
    if credential.is_symlink() or credential.stat().st_mode & 0o077:
        raise ValueError('INGRESS_CREDENTIAL_PERMISSIONS')
    token = credential.read_text().strip()
    port = operations['originPort']
    before = ORIGIN.read_bytes()
    after = render(before, port, web, token)
    preflight(f'http://127.0.0.1:{port}', token)
    receipt = {'status': 'PLANNED', 'release': str(release), 'versions': manifest['versions'],
               'beforeSha256': config.digest(before), 'afterSha256': config.digest(after),
               'rootSwitched': False, 'dataMoved': False, 'genuineSsoVerified': False}
    if args.apply:
        if args.expected_sha256 != config.digest(before):
            raise ValueError('BASELINE_DIGEST_REQUIRED')
        config.run(CHECK)
        backup = ORIGIN.with_name(ORIGIN.name + '.before-account-candidate-' + config.digest(before)[:16])
        with os.fdopen(os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'wb') as stream:
            stream.write(before); stream.flush(); os.fsync(stream.fileno())
        config.replace(ORIGIN, before, after)
        try:
            config.run(CHECK); config.run(RELOAD)
            preflight(f'http://127.0.0.1:{port}', token)
        except Exception:
            config.replace(ORIGIN, after, before); config.run(CHECK); config.run(RELOAD)
            raise
        receipt.update(status='CANDIDATE_ONLY_UPDATED', backup=str(backup))
    with args.receipt.open('x') as output:
        json.dump(receipt, output, indent=2)
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
