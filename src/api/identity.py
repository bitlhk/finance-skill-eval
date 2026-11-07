"""Existing ingress identity and persistent workspace layout for the Python API."""
import asyncio
from copy import deepcopy
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import shutil
import time
from urllib.parse import urlsplit, unquote

from filelock import FileLock


class AccessError(ValueError):
    def __init__(self, code, status=403, **details):
        super().__init__(code)
        self.code, self.status, self.details = code, status, details


def canonical_https_origin(value):
    if not isinstance(value, str):
        return False
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        authority = '[' + host + ']' if ':' in host else host
        if parsed.port and parsed.port != 443:
            authority += ':' + str(parsed.port)
        return (parsed.scheme == 'https' and bool(host) and not parsed.username and not parsed.password
                and value == 'https://' + authority and not parsed.path and not parsed.query and not parsed.fragment)
    except ValueError:
        return False


def digest(value):
    return hashlib.sha256(value.encode() if isinstance(value, str) else value).hexdigest()


def seed_files(directory):
    root, files, total = Path(directory), [], 0
    def walk(path, relative=''):
        nonlocal total
        if path.is_symlink() or getattr(path, 'is_junction', lambda: False)():
            raise AccessError('WORKSPACE_SEED_SYMLINK', 500)
        if path.is_dir():
            for child in sorted(path.iterdir(), key=lambda item: item.name.encode('utf-16-be')):
                if not relative and child.name not in ('skills', 'environments', 'preparations'):
                    raise AccessError('WORKSPACE_SEED_CONTENT_NOT_ALLOWED', 500)
                walk(child, relative + '/' + child.name if relative else child.name)
        else:
            size = path.stat().st_size
            if not path.is_file() or size > 8 * 1024 * 1024:
                raise AccessError('WORKSPACE_SEED_FILE_INVALID', 500)
            total += size
            if total > 32 * 1024 * 1024 or len(files) >= 2000:
                raise AccessError('WORKSPACE_SEED_TOO_LARGE', 500)
            content = path.read_bytes()
            if len(content) != size:
                raise AccessError('WORKSPACE_SEED_CHANGED', 500)
            files.append((relative, content))
    walk(root)
    return files


def read_seed(directory, expected):
    if not isinstance(expected, str) or not re.fullmatch(r'[a-f0-9]{64}', expected):
        raise AccessError('WORKSPACE_SEED_DIGEST_REQUIRED', 500)
    files = seed_files(directory)
    manifest = [{'path': name, 'sha256': digest(content)} for name, content in files]
    if digest(json.dumps(manifest, ensure_ascii=False, separators=(',', ':'))) != expected:
        raise AccessError('WORKSPACE_SEED_DIGEST_MISMATCH', 500)
    return files


class RequestBudget:
    def __init__(self, limits):
        self.limits, self.entries = limits, []
        if (any(type(value) is not int for value in limits.values()) or not 1 <= limits['perAccount'] <= limits['global'] <= 10000
                or not 1 <= limits['windowSeconds'] <= 86400):
            raise AccessError('WORKSPACE_REQUEST_BUDGET_INVALID', 500)

    def take(self, subject):
        now, window = time.monotonic(), self.limits['windowSeconds']
        self.entries = [(who, at) for who, at in self.entries if at > now - window]
        account = [(who, at) for who, at in self.entries if who == subject]
        scope, relevant = ('SERVICE', self.entries) if len(self.entries) >= self.limits['global'] else ('ACCOUNT', account)
        limit = self.limits['global'] if scope == 'SERVICE' else self.limits['perAccount']
        if len(relevant) >= limit:
            import math
            return {'scope': scope, 'retryAfterSeconds': max(1, math.ceil(relevant[0][1] + window - now))}
        self.entries.append((subject, now))
        return None


class WorkspaceIdentity:
    def __init__(self, config):
        self.config, self.opened = config, {}
        self.seed, self.lock = [], asyncio.Lock()
        account = config['workspaceMode'] == 'account'
        if os.environ.get('NODE_ENV') == 'production' and not config.get('accessToken'):
            raise AccessError('PRODUCTION_ACCESS_TOKEN_REQUIRED', 500)
        if config['workspaceMode'] not in ('account', 'single'):
            raise AccessError('INVALID_WORKSPACE_MODE', 500)
        if account or config.get('workspaceSubject'):
            if not config.get('accessToken') or config.get('publicDemo') or not canonical_https_origin(config.get('workspaceOrigin')):
                raise AccessError('TRUSTED_WORKSPACE_INGRESS_REQUIRED', 500)
        if config.get('publicDemo') and not config.get('accessToken'):
            raise AccessError('PUBLIC_DEMO_ACCESS_TOKEN_REQUIRED', 500)
        if config.get('workspaceSubject') and not re.fullmatch(r'studio_[a-zA-Z0-9_-]+', config['workspaceSubject']):
            raise AccessError('INVALID_WORKSPACE_SUBJECT', 500)
        if account:
            if type(config['workspaceMaxAccounts']) is not int or not 1 <= config['workspaceMaxAccounts'] <= 256:
                raise AccessError('WORKSPACE_ACCOUNT_LIMIT_INVALID', 500)
            if not config.get('workspaceSeedDirectory') or not config.get('workspaceSeedSha256'):
                raise AccessError('WORKSPACE_SEED_REQUIRED', 500)
            self.seed = read_seed(config['workspaceSeedDirectory'], config['workspaceSeedSha256'])
        self.work = RequestBudget(config['workspaceRequestLimits'])
        self.preflight = RequestBudget(config['workspacePreflightLimits'])

    async def resolve(self, method, path, headers):
        config = self.config
        try:
            route = unquote(path.split('?')[0], errors='strict')
        except UnicodeError:
            raise AccessError('INVALID_REQUEST_PATH', 400) from None
        if route == '/api/health' or not route.startswith('/api/'):
            return config
        token = config.get('accessToken')
        actual = headers.get('authorization', '')
        if token:
            expected = 'Bearer ' + token
            if config['workspaceMode'] != 'account':
                match = re.fullmatch(r'Bearer\s+(.+)', actual, re.I)
                actual = 'Bearer ' + match.group(1) if match else ''
            if not hmac.compare_digest(actual.encode(), expected.encode()):
                raise AccessError('UNAUTHORIZED', 401)
        subject = headers.get('x-demo-user', '')
        if config['workspaceMode'] == 'account':
            if not re.fullmatch(r'studio_[a-zA-Z0-9_-]{1,120}', subject):
                raise AccessError('AUTHENTICATED_ACCOUNT_REQUIRED')
        elif config.get('workspaceSubject') and subject != config['workspaceSubject']:
            raise AccessError('WORKSPACE_OWNER_REQUIRED')
        if (config['workspaceMode'] == 'account' or config.get('workspaceSubject')) and method not in ('GET', 'HEAD', 'OPTIONS'):
            if headers.get('origin') != config['workspaceOrigin']:
                raise AccessError('WORKSPACE_ORIGIN_REQUIRED')
        if config['workspaceMode'] != 'account':
            return config
        preflight = method == 'POST' and re.fullmatch(r'/api/environments/[^/]+/preflight/?', route)
        work = method not in ('GET', 'HEAD', 'OPTIONS') or bool(re.fullmatch(r'/api/migrations/[^/]+/(diagnosis|inspection|report|export)/?', route))
        if method == 'POST' and re.fullmatch(r'/api/(runs|migration-bundles)/[^/]+/cancel/?|/api/optimizations/[^/]+/decision/?', route):
            work = False
        if preflight or work:
            refusal = (self.preflight if preflight else self.work).take(subject)
            if refusal:
                raise AccessError('WORKSPACE_REQUEST_LIMIT', 429, **refusal, budget='PREFLIGHT' if preflight else 'WORK')
        async with self.lock:
            if subject not in self.opened:
                if len(self.opened) >= config['workspaceMaxAccounts']:
                    raise AccessError('WORKSPACE_CAPACITY_REACHED', 503)
                self.opened[subject] = await asyncio.to_thread(self._open, subject)
            return self.opened[subject]

    def _open(self, subject):
        config = deepcopy(self.config)
        if subject == config.get('workspaceSubject'):
            directory = Path(config['dataDirectory'])
        else:
            root = Path(config['dataDirectory']) / 'account-workspaces'
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            if root.is_symlink() or getattr(root, 'is_junction', lambda: False)():
                raise AccessError('WORKSPACE_DIRECTORY_UNSAFE', 500)
            name = digest(subject)
            directory, staging = root / name, root / ('.initializing-' + name)
            with FileLock(str(root / ('.initialize-' + name + '.lock'))):
                if directory.is_symlink() or getattr(directory, 'is_junction', lambda: False)():
                    raise AccessError('WORKSPACE_DIRECTORY_UNSAFE', 500)
                if not directory.exists():
                    if staging.exists():
                        if staging.resolve().parent != root.resolve() or staging.name != '.initializing-' + name:
                            raise AccessError('WORKSPACE_DIRECTORY_UNSAFE', 500)
                        shutil.rmtree(staging)
                    staging.mkdir(mode=0o700)
                    try:
                        for relative, content in self.seed:
                            target = staging / relative
                            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                            with target.open('xb') as file:
                                file.write(content)
                        (staging / 'workspace-origin.json').write_text(json.dumps({'schemaVersion': 'finance.account-workspace.v1',
                            'subjectHash': name, 'seedSha256': config['workspaceSeedSha256']}, separators=(',', ':')), encoding='utf-8')
                        staging.rename(directory)
                    except BaseException:
                        if staging.resolve().parent == root.resolve() and staging.name == '.initializing-' + name:
                            shutil.rmtree(staging)
                        raise
        config.update(workspaceMode='single', workspaceSubject=subject, dataDirectory=str(directory), managedWorkspace=True)
        return config
