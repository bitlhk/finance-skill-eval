import json
from typing import TypedDict
from urllib.request import Request, urlopen
import legacy_runtime
import auth_sdk

class User(TypedDict):
    id: str
    tenantId: str

def request_json(operation: str, payload: dict) -> dict:
    user: User = legacy_runtime.current_user
    token = auth_sdk.get_token(user, legacy_runtime.app_key)
    request = Request(legacy_runtime.service_url + '/business/' + operation,
                      data=json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    with urlopen(request, timeout=5) as response:
        return json.load(response)
