import json
from typing import Protocol
from urllib.request import Request, urlopen
import auth_sdk

class RuntimeContext(Protocol):
    user: dict
    service_url: str
    app_key: str
    department_rules: dict

def request_json(operation: str, payload: dict, context: RuntimeContext) -> dict:
    token = auth_sdk.get_token(context.user, context.app_key)
    request = Request(context.service_url + '/business/' + operation,
                      data=json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token})
    with urlopen(request, timeout=5) as response:
        return json.load(response)
