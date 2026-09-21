from decimal import Decimal
from http_client import request_json
def check_budget(department: str, amount: str, user: dict, service_url: str, credential: str, department_rules: dict) -> dict:
    result = request_json('budget', {'department': department}, service_url, credential)
    reserve = Decimal(department_rules[department]['reserve'])
    return {**result, 'reserve': str(reserve), 'enough': Decimal(amount) <= Decimal(result['available']) - reserve}

if __name__ == '__main__':
    import sys, json
    print(json.dumps(check_budget(**json.load(sys.stdin))))
