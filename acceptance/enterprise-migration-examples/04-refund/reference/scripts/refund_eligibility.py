from decimal import Decimal
from http_client import request_json
def refund_eligibility(order_id: str, user: dict, service_url: str, credential: str) -> dict:
    order = request_json('order', {'order_id': order_id}, service_url, credential)
    if 'error' in order: return {'order_id': order_id, 'eligible': False, 'reason': order['error']}
    policy = request_json('refund-policy', {}, service_url, credential)
    if order['status'] not in policy['allowed_statuses']:
        return {'order_id': order_id, 'eligible': False, 'reason': 'STATUS_NOT_REFUNDABLE'}
    remaining = Decimal(order['paid_cents'] - order['refunded_cents']) / Decimal(100)
    return {'order_id': order_id, 'eligible': True, 'currency': policy['currency'], 'refundable_amount': str(remaining.quantize(Decimal('.01')))}

if __name__ == '__main__':
    import sys, json
    print(json.dumps(refund_eligibility(**json.load(sys.stdin))))
