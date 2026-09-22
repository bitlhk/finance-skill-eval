import json
from urllib.request import Request, urlopen

def request_json(operation, payload, service_url, credential):
    request = Request(service_url + '/business/' + operation, data=json.dumps(payload).encode(),
                      headers={'Content-Type': 'application/json', 'Authorization': credential})
    with urlopen(request, timeout=5) as response:
        return json.load(response)
