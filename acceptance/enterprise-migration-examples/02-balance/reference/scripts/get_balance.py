from http_client import request_json
def get_balance(account_id: str, user: dict, service_url: str, credential: str) -> dict:
    return request_json('balance', {'account_id': account_id}, service_url, credential)

if __name__ == '__main__':
    import sys, json
    print(json.dumps(get_balance(**json.load(sys.stdin))))
