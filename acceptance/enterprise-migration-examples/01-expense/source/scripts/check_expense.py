import json
from pathlib import Path
from decimal import Decimal
from typing import Protocol
from agentscope.tool import Toolkit

class ExpenseContext(Protocol):
    workspace: str

def check_expense(claim_id: str, context: ExpenseContext) -> dict:
    rules = json.loads((Path(__file__).resolve().parents[1] / 'assets/rules.json').read_text(encoding='utf-8'))
    file = Path(context.workspace) / (claim_id + '.json')
    if not file.exists(): return {'claim_id': claim_id, 'error': 'CLAIM_NOT_FOUND'}
    entries = json.loads(file.read_text(encoding='utf-8'))
    violations = [e['id'] for e in entries if e['category'] not in rules['allowedCategories'] or
                  (e['category'] == 'meal' and Decimal(e['amount']) > Decimal(rules['mealLimit']))]
    return {'claim_id': claim_id, 'total': str(sum((Decimal(e['amount']) for e in entries), Decimal('0')).quantize(Decimal('.01'))),
            'violations': violations, 'compliant': not violations}

def build_toolkit(context: ExpenseContext) -> Toolkit:
    toolkit = Toolkit()
    toolkit.register_tool_function(check_expense, preset_kwargs={'context': context})
    return toolkit
