"""Prepare/apply a CAS-protected root promotion; never migrate or restore data."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re

spec = importlib.util.spec_from_file_location('candidate', Path(__file__).with_name('promote-account-candidate.py'))
candidate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(candidate)
config = candidate.config
ORIGIN = Path('/home/ubuntu/finance-skill-eval/deploy/finance-eval-origin.nginx.conf')
GATEWAY = Path('/etc/nginx/conf.d/finance-eval.demo.linggan.top.conf')


def block(text, selector):
    pattern = r'(?m)^[ \t]*location ' + re.escape(selector) + r' \{[^{}]*\}'
    matches = list(re.finditer(pattern, text))
    if len(matches) != 1 or len(re.findall(r'\blocation\s+' + re.escape(selector) + r'\s*\{', text)) != 1:
        raise ValueError('EXPECTED_SINGLE_LOCATION:' + selector)
    return matches[0]


def render_origin(before, web, token, port):
    text = before.decode()
    if (not isinstance(port, int) or not 1024 <= port <= 65535
            or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(web))
            or '..' in Path(web).parts
            or not re.fullmatch(r'[A-Za-z0-9._~+/-]{32,256}', token)):
        raise ValueError('INVALID_TARGET')
    for guard in ('allow 116.204.37.89;', 'deny all;', 'release-check-origin.conf;'):
        if text.count(guard) != 1:
            raise ValueError('ORIGIN_BOUNDARY_CHANGED')
    if re.search(r'location\s+(?:=|\^~)?\s*/api', text):
        raise ValueError('EXISTING_ROOT_API_REQUIRES_REVIEW')
    root = block(text, '/')
    if not re.fullmatch(r'\s*location / \{\s*proxy_pass http://127\.0\.0\.1:56371;\s*'
                        r'proxy_http_version 1\.1;\s*proxy_set_header Host \$http_host;\s*'
                        r'proxy_set_header Connection "";\s*proxy_buffering off;\s*'
                        r'proxy_cache off;\s*proxy_read_timeout 600s;\s*'
                        r'proxy_send_timeout 600s;\s*\}', root.group()):
        raise ValueError('ROOT_BASELINE_CHANGED')
    replacement = f'''        location ^~ /api/ {{
            client_max_body_size 8m;
            proxy_pass http://127.0.0.1:{port}/api/;
            proxy_http_version 1.1;
            proxy_set_header Authorization "Bearer {token}";
            proxy_set_header X-Demo-User $http_x_demo_user;
            proxy_set_header X-Migration-Authorization "";
            proxy_set_header Cookie "";
            proxy_set_header Host $http_host;
            proxy_set_header Connection "";
            proxy_buffering off;
            proxy_cache off;
            proxy_read_timeout 950s;
            proxy_send_timeout 600s;
            add_header Cache-Control "no-store" always;
        }}
        location / {{
            root {web};
            try_files $uri $uri/ /index.html;
            add_header Cache-Control "no-store" always;
            add_header X-Content-Type-Options "nosniff" always;
            add_header Referrer-Policy "no-referrer" always;
        }}'''
    return (text[:root.start()] + replacement + text[root.end():]).encode()


def render_gateway(before):
    text = before.decode()
    for selector in ('^~ /api/', '/'):
        found = block(text, selector)
        old = found.group()
        for guard in ('auth_request /__auth_check;',
                      'auth_request_set $demo_user $upstream_http_x_studio_user;',
                      'proxy_set_header X-Demo-User $demo_user;',
                      'proxy_set_header Cookie "";', 'proxy_pass $demo_upstream;'):
            if old.count(guard) != 1:
                raise ValueError('GATEWAY_AUTH_BOUNDARY_CHANGED')
        if 'client_max_body_size' in old or old.count('proxy_read_timeout 600s;') != 1:
            raise ValueError('GATEWAY_BUDGET_BASELINE_CHANGED')
        new = old.replace('proxy_read_timeout 600s;', 'proxy_read_timeout 950s;')
        if selector == '^~ /api/':
            new = new.replace('{', '{\n        client_max_body_size 8m;', 1)
        text = text[:found.start()] + new + text[found.end():]
    return text.encode()


def check_web(web):
    if web.is_symlink() or web.resolve() != web:
        raise ValueError('STATIC_PATH_NOT_CANONICAL')
    files = {}
    for path in sorted(web.rglob('*')):
        if path.is_symlink():
            raise ValueError('STATIC_SYMLINK')
        if path.is_file():
            files[str(path.relative_to(web))] = config.digest(path.read_bytes())
    index = (web / 'index.html').read_text()
    if '/release-check/' in index or 'src="/assets/' not in index:
        raise ValueError('ROOT_BUILD_REQUIRED')
    for asset in re.findall(r'(?:src|href)="(/assets/[^"?#]+)"', index):
        if asset[1:] not in files:
            raise ValueError('ROOT_ASSET_MISSING')
    return config.digest(json.dumps(files, sort_keys=True).encode())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--target', choices=['origin', 'gateway'], required=True)
    parser.add_argument('--release', type=Path)
    parser.add_argument('--web', type=Path)
    parser.add_argument('--expected-sha256')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--receipt', type=Path, required=True)
    parser.add_argument('--rollback', type=Path)
    args = parser.parse_args()
    path = ORIGIN if args.target == 'origin' else GATEWAY
    check = candidate.CHECK if args.target == 'origin' else ['/usr/sbin/nginx', '-t']
    reload = candidate.RELOAD if args.target == 'origin' else ['systemctl', 'reload', 'nginx']
    if path.is_symlink() or args.receipt.exists():
        raise ValueError('UNSAFE_PATH_OR_EXISTING_RECEIPT')
    before = path.read_bytes()
    receipt = {'status': 'PLANNED', 'target': args.target, 'config': str(path),
               'beforeSha256': config.digest(before), 'dataMoved': False,
               'genuineSsoVerified': False}
    if args.rollback:
        previous = json.loads(args.rollback.read_text())
        backup = Path(previous['backup'])
        if (previous['config'] != str(path) or previous['afterSha256'] != config.digest(before)
                or backup.parent != path.parent or backup.is_symlink()):
            raise ValueError('ROLLBACK_BASELINE_CHANGED')
        after = backup.read_bytes()
        if config.digest(after) != previous['beforeSha256']:
            raise ValueError('BACKUP_DIGEST_MISMATCH')
    elif args.target == 'gateway':
        after = render_gateway(before)
    else:
        release = args.release
        if (release is None or release.parent != candidate.RELEASES
                or release.is_symlink() or release.resolve() != release
                or args.web is None or args.web.parent != release / 'web'):
            raise ValueError('INVALID_RELEASE_DIRECTORY')
        receipt['staticManifestSha256'] = check_web(args.web)
        credential = release / 'config/ingress-token'
        if credential.is_symlink() or credential.stat().st_mode & 0o077:
            raise ValueError('PRIVATE_INGRESS_REQUIRED')
        token = credential.read_text().strip()
        operations = json.loads((release / 'operations.json').read_text())
        if operations['workspaceMode'] != 'account':
            raise ValueError('ACCOUNT_MODE_REQUIRED')
        port = operations['originPort']
        candidate.preflight(f'http://127.0.0.1:{port}', token)
        after = render_origin(before, args.web, token, port)
        receipt['release'] = str(release)
        receipt['versions'] = json.loads((release / 'release.json').read_text())['versions']
    receipt['afterSha256'] = config.digest(after)
    if args.apply:
        if args.expected_sha256 != config.digest(before):
            raise ValueError('BASELINE_DIGEST_REQUIRED')
        config.run(check)
        backup = path.with_name(path.name + '.before-root-' + config.digest(before)[:16])
        with os.fdopen(os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'wb') as stream:
            stream.write(before); stream.flush(); os.fsync(stream.fileno())
        config.replace(path, before, after)
        try:
            config.run(check); config.run(reload)
        except Exception:
            config.replace(path, after, before); config.run(check); config.run(reload)
            raise
        receipt.update(status='ROLLED_BACK' if args.rollback else 'APPLIED', backup=str(backup))
    with os.fdopen(os.open(args.receipt, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'w') as stream:
        json.dump(receipt, stream, indent=2)
    print(json.dumps(receipt))


if __name__ == '__main__':
    main()
