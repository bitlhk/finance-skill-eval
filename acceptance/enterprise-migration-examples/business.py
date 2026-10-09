"""Synthetic, deterministic business rules shared by original-service fixtures."""
from decimal import Decimal

EXPENSES = {
    'EXP-001': [{'id': 'E1', 'category': 'meal', 'amount': '120.00'}, {'id': 'E2', 'category': 'taxi', 'amount': '80.00'}],
    'EXP-002': [{'id': 'E3', 'category': 'meal', 'amount': '180.00'}, {'id': 'E4', 'category': 'gift', 'amount': '50.00'}],
}
BALANCES = {'ACC-001': {'owner': 'U001', 'balance': '1280.50'}, 'ACC-002': {'owner': 'U002', 'balance': '900.00'}}
BALANCES.update({'ACC-101': {'owner': 'U001', 'balance': '0.00'},
                 'ACC-102': {'owner': 'U001', 'balance': '0.01'},
                 'ACC-103': {'owner': 'U002', 'balance': '8877.66'}})
REQUESTS = {
    'PO-001': {'department': 'D001', 'supplier': 'S001', 'amount': '500.00'},
    'PO-002': {'department': 'D001', 'supplier': 'S001', 'amount': '1500.00'},
    'PO-003': {'department': 'D001', 'supplier': 'S002', 'amount': '300.00'},
    'PO-101': {'department': 'D001', 'supplier': 'S001', 'amount': '900.00'},
    'PO-102': {'department': 'D001', 'supplier': 'S001', 'amount': '900.01'},
    'PO-103': {'department': 'D001', 'supplier': 'S002', 'amount': '1500.00'},
}
ORDERS = {'RF-001': {'paid_cents': 12000, 'refunded_cents': 2000, 'status': 'PAID'},
          'RF-002': {'paid_cents': 6000, 'refunded_cents': 0, 'status': 'SHIPPED'}}
ORDERS.update({'RF-101': {'paid_cents': 12000, 'refunded_cents': 12000, 'status': 'PAID'},
               'RF-102': {'paid_cents': 12000, 'refunded_cents': 11999, 'status': 'PAID'},
               'RF-103': {'paid_cents': 12000, 'refunded_cents': 2000, 'status': 'SHIPPED'}})


def expense_check(claim_id, entries, rules):
    violations = [e['id'] for e in entries if e['category'] not in rules['allowedCategories'] or
                  (e['category'] == 'meal' and Decimal(e['amount']) > Decimal(rules['mealLimit']))]
    return {'claim_id': claim_id, 'total': str(sum((Decimal(e['amount']) for e in entries), Decimal('0')).quantize(Decimal('.01'))),
            'violations': violations, 'compliant': not violations}


def api(operation, payload, user):
    if operation == 'balance':
        item = BALANCES.get(payload['account_id'])
        if item is None: return {'error': 'ACCOUNT_NOT_FOUND'}
        if user['id'] != item['owner']: return {'error': 'PERMISSION_DENIED'}
        return {'account_id': payload['account_id'], 'currency': 'CNY', 'balance': item['balance']}
    if operation == 'request':
        item = REQUESTS.get(payload['request_id'])
        return {'request_id': payload['request_id'], **item} if item else {'error': 'REQUEST_NOT_FOUND'}
    if operation == 'budget':
        return {'department': payload['department'], 'available': '1000.00'}
    if operation == 'supplier':
        return {'supplier': payload['supplier'], 'active': payload['supplier'] == 'S001'}
    if operation == 'order':
        item = ORDERS.get(payload['order_id'])
        return {'order_id': payload['order_id'], **item} if item else {'error': 'ORDER_NOT_FOUND'}
    if operation == 'refund-policy': return {'allowed_statuses': ['PAID'], 'currency': 'CNY'}
    raise ValueError('Unknown operation')
