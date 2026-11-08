import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts' / 'lib'))
from live_project_process import process_evidence


class LiveProjectProcessTests(unittest.TestCase):
    def test_preserves_observed_tool_fields_without_claiming_complete_trace(self):
        result = process_evidence([{'name': 'lookup', 'call_id': 'c1', 'status': 'failed',
                                    'input': {'query': 'a'}, 'content': ['x'], 'error': 'failed'}], {})
        self.assertEqual(result['status'], 'PARTIAL')
        self.assertEqual(result['scopes'], ['events', 'tools'])
        self.assertEqual(result['records'][1], {'id': 'event-0', 'kind': 'tool', 'name': 'lookup',
                         'callId': 'c1', 'status': 'failed', 'input': {'query': 'a'},
                         'output': ['x'], 'error': 'failed'})

    def test_old_or_duplicate_call_does_not_invent_identity(self):
        result = process_evidence([{'name': 'old', 'content': ['x']},
                                   {'name': 'lookup', 'call_id': 'c1', 'status': 'completed'},
                                   {'name': 'lookup', 'call_id': 'c1', 'status': 'completed'}], {})
        self.assertEqual([row['kind'] for row in result['records']], ['event', 'event', 'tool', 'event'])
        self.assertNotIn('callId', result['records'][1])


if __name__ == '__main__':
    unittest.main()
