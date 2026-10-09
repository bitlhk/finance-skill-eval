"""Independent source-oracle checks for the new UI holdouts; no model substitutions."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile
from threading import Thread
import unittest
from urllib.request import Request, urlopen

from server import ROOT, invoke_original, make_server


class ImprovementBusinessCases(unittest.TestCase):
    def test_private_audit_records_actual_identity_without_credentials(self):
        with tempfile.TemporaryDirectory(prefix='business-audit-') as directory:
            destination = Path(directory) / 'audit.jsonl'
            server = make_server(audit_file=destination)
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for user in ['U001', 'U002']:
                    request = Request(f'http://127.0.0.1:{server.server_port}/business/balance',
                                      data=json.dumps({'account_id': 'ACC-103'}).encode(),
                                      headers={'Authorization': f'Bearer fixture:T001:{user}', 'Content-Type': 'application/json'})
                    with urlopen(request) as response:
                        self.assertEqual(response.status, 200)
                text = destination.read_text(encoding='utf-8')
                calls = [json.loads(line) for line in text.splitlines()]
                self.assertEqual([c['userId'] for c in calls], ['U001', 'U002'])
                self.assertEqual(calls[0]['result'], {'error': 'PERMISSION_DENIED'})
                self.assertEqual(calls[1]['result']['balance'], '8877.66')
                self.assertNotIn('Bearer', text)
                self.assertNotIn('Authorization', text)
            finally:
                server.shutdown(); server.server_close(); thread.join(5)

    @classmethod
    def setUpClass(cls):
        cls.server = make_server()
        cls.thread = Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join(5)

    def original(self, name, inputs):
        return invoke_original(name, inputs, self.server.server_port, {'id': 'U001', 'tenantId': 'T001'})

    def test_expense_boundary_and_empty_file(self):
        for claim, entries, total, violations in [
            ('EXP-101', [{'id': 'B1', 'category': 'meal', 'amount': '150.00'}], '150.00', []),
            ('EXP-102', [{'id': 'B2', 'category': 'meal', 'amount': '150.01'}, {'id': 'B3', 'category': 'taxi', 'amount': '0.01'}], '150.02', ['B2']),
            ('EXP-103', [], '0.00', []),
        ]:
            with self.subTest(claim=claim), tempfile.TemporaryDirectory(prefix='expense-holdout-') as work:
                workspace = Path(work) / 'workspace'
                workspace.mkdir()
                (workspace / (claim + '.json')).write_text(json.dumps(entries), encoding='utf-8')
                result = subprocess.run([sys.executable, '-B', str(ROOT / '01-expense/source/scripts/check_expense.py')],
                                        cwd=work, input=json.dumps({'claim_id': claim}), text=True, capture_output=True, check=True)
                self.assertEqual(json.loads(result.stdout), {'claim_id': claim, 'total': total, 'violations': violations, 'compliant': not violations})

    def test_balance_zero_precision_and_denied_identity(self):
        for account, expected in [
            ('ACC-101', {'account_id': 'ACC-101', 'currency': 'CNY', 'balance': '0.00'}),
            ('ACC-102', {'account_id': 'ACC-102', 'currency': 'CNY', 'balance': '0.01'}),
            ('ACC-103', {'error': 'PERMISSION_DENIED'}),
        ]:
            with self.subTest(account=account):
                self.assertEqual(self.original('02-balance', {'account_id': account}), expected)

    def test_procurement_boundary_double_rejection_and_short_circuit(self):
        for request, expected in [
            ('PO-101', {'request_id': 'PO-101', 'approved': True, 'reasons': []}),
            ('PO-102', {'request_id': 'PO-102', 'approved': False, 'reasons': ['BUDGET_EXCEEDED']}),
            ('PO-103', {'request_id': 'PO-103', 'approved': False, 'reasons': ['BUDGET_EXCEEDED', 'SUPPLIER_INACTIVE']}),
            ('PO-404', {'error': 'REQUEST_NOT_FOUND'}),
        ]:
            with self.subTest(request=request):
                before = len(self.server.calls)
                self.assertEqual(self.original('03-procurement', {'request_id': request}), expected)
                self.assertEqual([c['operation'] for c in self.server.calls[before:]],
                                 ['request'] if request == 'PO-404' else ['request', 'budget', 'supplier'])

    def test_refund_zero_cent_and_status(self):
        for order, expected in [
            ('RF-101', {'order_id': 'RF-101', 'eligible': True, 'currency': 'CNY', 'refundable_amount': '0.00'}),
            ('RF-102', {'order_id': 'RF-102', 'eligible': True, 'currency': 'CNY', 'refundable_amount': '0.01'}),
            ('RF-103', {'order_id': 'RF-103', 'eligible': False, 'reason': 'STATUS_NOT_REFUNDABLE'}),
        ]:
            with self.subTest(order=order):
                self.assertEqual(self.original('04-refund', {'order_id': order}), expected)


if __name__ == '__main__':
    unittest.main()
