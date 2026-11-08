"""Application configuration using the existing deployment environment names."""
import json
import os
from pathlib import Path


def load_configuration(overrides=None):
    env = os.environ
    root = Path(env.get('FINANCE_EVAL_ROOT') or Path.cwd()).absolute()
    config = {'rootDirectory': str(root),
        'dataDirectory': str(Path(env.get('FINANCE_EVAL_DATA_DIR') or root / 'data').absolute()),
        'publicDirectory': str(Path(env.get('FINANCE_EVAL_PUBLIC_DIR') or root / 'web-dist').absolute()),
        'host': env.get('FINANCE_EVAL_HOST') or '0.0.0.0', 'port': int(env.get('FINANCE_EVAL_PORT', '56361')),
        'accessToken': env.get('FINANCE_EVAL_ACCESS_TOKEN', '').strip() or None,
        'publicDemo': env.get('FINANCE_EVAL_PUBLIC_DEMO') == 'true',
        'workspaceMode': env.get('FINANCE_EVAL_WORKSPACE_MODE', 'single'),
        'workspaceSubject': env.get('FINANCE_EVAL_WORKSPACE_SUBJECT', '').strip() or None,
        'workspaceOrigin': env.get('FINANCE_EVAL_WORKSPACE_ORIGIN', '').strip() or None,
        'workspaceSeedDirectory': env.get('FINANCE_EVAL_WORKSPACE_SEED_DIRECTORY', '').strip() or None,
        'workspaceSeedSha256': env.get('FINANCE_EVAL_WORKSPACE_SEED_SHA256', '').strip() or None,
        'workspaceMaxAccounts': int(env.get('FINANCE_EVAL_WORKSPACE_MAX_ACCOUNTS', '64')),
        'maxConcurrentRuns': max(1, min(4, int(env.get('FINANCE_EVAL_MAX_CONCURRENT_RUNS', '1')))),
        'managedWorkspace': False,
        'launcherTrust': json.loads(env.get('FINANCE_EVAL_LAUNCHER_TRUST_JSON') or '[]')}
    for name, prefix, per_account, global_ in [('workspaceRequestLimits', 'REQUESTS', 20, 80),
                                              ('workspacePreflightLimits', 'PREFLIGHTS', 60, 240)]:
        config[name] = {'perAccount': int(env.get(f'FINANCE_EVAL_WORKSPACE_{prefix}_PER_ACCOUNT', str(per_account))),
                        'global': int(env.get(f'FINANCE_EVAL_WORKSPACE_{prefix}_GLOBAL', str(global_))),
                        'windowSeconds': int(env.get('FINANCE_EVAL_WORKSPACE_REQUEST_WINDOW_SECONDS', '60'))}
    config.update(overrides or {})
    config.setdefault('legacyOrderIndex', str(Path(config['dataDirectory']) / 'native-asset-orders.json'))
    config.setdefault('coordinationDirectory', config['dataDirectory'])
    return config
