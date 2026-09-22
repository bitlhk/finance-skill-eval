"""Demo SDK: deterministic fixture credentials, never production authentication."""


def get_token(user: dict, app_key: str) -> str:
    if app_key != 'demo-app': raise ValueError('INVALID_APP_KEY')
    return 'fixture:' + user['tenantId'] + ':' + user['id']


def authenticate(user: dict, appKey: str) -> dict:
    return {'Authorization': 'Bearer ' + get_token(user, appKey)}
