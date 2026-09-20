from decimal import Decimal
from tools.http_client import request_json
from department_config import DEPARTMENT_RULES
def check_budget(department: str, amount: str) -> dict:
    result = request_json('budget', {'department': department})
    reserve = Decimal(DEPARTMENT_RULES[department]['reserve'])
    return {**result, 'reserve': str(reserve), 'enough': Decimal(amount) <= Decimal(result['available']) - reserve}
