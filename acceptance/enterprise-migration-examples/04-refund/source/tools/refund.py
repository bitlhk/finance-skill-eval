from decimal import Decimal
import json
import shutil
from agentscope.message import TextBlock
from agentscope.tool import ToolResponse
from tools.http_client import RuntimeContext, request_json

async def refund_eligibility(order_id: str, context: RuntimeContext) -> ToolResponse:
    order = request_json('order', {'order_id': order_id}, context)
    if 'error' in order: result = {'order_id': order_id, 'eligible': False, 'reason': order['error']}
    else:
        policy = request_json('refund-policy', {}, context)
        if order['status'] not in policy['allowed_statuses']:
            result = {'order_id': order_id, 'eligible': False, 'reason': 'STATUS_NOT_REFUNDABLE'}
        else:
            remaining = Decimal(order['paid_cents'] - order['refunded_cents']) / Decimal(100)
            result = {'order_id': order_id, 'eligible': True, 'currency': policy['currency'], 'refundable_amount': str(remaining.quantize(Decimal('.01')))}
    return ToolResponse(content=[TextBlock(type='text', text=json.dumps(result))], metadata={'businessResult': result})
