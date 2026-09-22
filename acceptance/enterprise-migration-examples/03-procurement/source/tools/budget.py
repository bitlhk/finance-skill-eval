from decimal import Decimal
from tools.http_client import RuntimeContext, request_json
def check_budget(department: str, amount: str, context: RuntimeContext) -> dict:
    result = request_json('budget', {'department': department}, context)
    reserve = Decimal(context.department_rules[department]['reserve'])
    return {**result, 'reserve': str(reserve), 'enough': Decimal(amount) <= Decimal(result['available']) - reserve}
