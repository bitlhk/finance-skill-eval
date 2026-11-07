"""Optional real-model check of the SDK agent and its tool boundaries."""
import io
import json
import os
import unittest
from unittest.mock import patch


@unittest.skipUnless(os.environ.get('FINANCE_TEST_REAL_AGENT') == '1', 'Requires a configured live optimization model')
class LiveOptimizationAgentTest(unittest.IsolatedAsyncioTestCase):
    async def test_agent_drives_a_real_reviewed_optimization(self):
        import sys
        from pathlib import Path
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations' / 'openjiuwen'))
        import optimization_agent
        baseline = {'id': 'base', 'candidate': {'id': 'base', 'digest': 'base'}, 'protocolDigest': 'same',
                    'cases': [{'id': 'case-1', 'passed': False, 'observation': '缺少会议室容量过滤'}]}
        candidate = {'id': 'new', 'candidate': {'id': 'new', 'digest': 'new'}, 'protocolDigest': 'same',
                     'cases': [{'id': 'case-1', 'passed': True, 'observation': '正确过滤容量'}]}
        state = {'id': 'live-loop', 'goal': {'goal': '正确过滤会议室容量', 'maxRounds': 1, 'targetPassRate': 1},
                 'baseline': baseline['candidate'], 'best': baseline['candidate'], 'bestEvaluationId': 'base',
                 'status': 'RUNNING', 'stage': 'DIAGNOSIS', 'rounds': [], 'deadlineAt': '2099-01-01T00:00:00Z'}
        calls = []
        class FixturePorts:
            def __init__(self, output): pass
            async def invoke(self, name, payload):
                calls.append(name)
                values = {'diagnose': {'status': 'PROPOSED', 'hypothesis': {'layer': 'TOOL', 'issue': '缺少容量过滤'}},
                          'adjust': candidate['candidate'], 'evaluate': candidate,
                          'review': {'status': 'PRODUCED', 'review': {'recommendation': 'KEEP_CANDIDATE',
                              'reason': '业务用例已通过', 'improvements': ['容量过滤'], 'regressions': [], 'evidenceIds': ['case-1']}}}
                return {'value': values.get(name)}
        output = io.StringIO()
        await optimization_agent.run({'state': state, 'baseline': baseline, 'modelTimeoutMs': 180000}, output, invoke=FixturePorts(output).invoke)
        activity = [json.loads(line).get('activity', {}).get('label') for line in output.getvalue().splitlines() if 'activity' in line]
        self.assertEqual(state['status'], 'REVIEW', str({'reason': state.get('reason'), 'calls': calls, 'activity': activity}))
        self.assertEqual(state['best']['id'], 'new')
        self.assertTrue({'diagnose', 'adjust', 'evaluate', 'review'} <= set(calls))
        self.assertTrue(any(json.loads(line).get('type') == 'result' for line in output.getvalue().splitlines()))
