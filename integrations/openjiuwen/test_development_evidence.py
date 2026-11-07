import unittest

from .development_evidence import build_evaluation_evidence_tool


class DevelopmentEvidenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_large_native_evidence_is_queried_in_bounded_chunks(self):
        import json
        tool = build_evaluation_evidence_tool([{'runId': 'large', 'candidateDigest': 'current', 'status': 'PASSED',
            'cases': [{'id': 'one', 'verdict': 'PASS'}, {'id': 'two', 'verdict': 'FAIL'}],
            'evaluationEvidence': {'current': [{'output': 'x' * 300000}]}}], lambda: 'current')
        overview = await tool.invoke({'run_id': 'large'})
        self.assertLess(len(json.dumps(overview)), 3000)
        self.assertEqual(len(overview['cases']), 2)
        self.assertNotIn('evaluationEvidence', overview)
        result = await tool.invoke({'run_id': 'large', 'path': '/evaluationEvidence/current', 'operation': 'list'})
        self.assertEqual(result['query']['entries'][0]['path'], '/evaluationEvidence/current/0')
        result = await tool.invoke({'run_id': 'large', 'path': '/evaluationEvidence/current/0/output', 'limit': 40})
        self.assertEqual(len(result['query']['content']), 40)
        self.assertEqual(result['query']['nextOffset'], 40)

    async def test_lookup_rechecks_current_files_and_never_invents_a_result(self):
        current = ['digest-1']
        tool = build_evaluation_evidence_tool([{'runId': 'run-1', 'candidateId': 'candidate-1',
            'candidateDigest': 'digest-1', 'status': 'INCOMPLETE', 'effectStatus':'PASSED', 'cases': [{'id': 'case-1'}]}], lambda: current[0])
        listing = await tool.invoke({})
        self.assertTrue(listing['evaluations'][0]['matchesCurrentWorkspace'])
        self.assertEqual(listing['evaluations'][0]['status'],'INCOMPLETE')
        self.assertEqual(listing['evaluations'][0]['effectStatus'],'PASSED')
        current[0] = 'digest-2'
        evidence = await tool.invoke({'run_id': 'run-1'})
        self.assertFalse(evidence['matchesCurrentWorkspace'])
        self.assertEqual(evidence['cases'], [{'id': 'case-1'}])
        self.assertFalse((await tool.invoke({'run_id': 'missing'}))['found'])
        unavailable = build_evaluation_evidence_tool([{'runId':'run-2','candidateDigest':'digest-2',
            'status':'UNAVAILABLE'}], lambda: current[0])
        self.assertFalse((await unavailable.invoke({'run_id':'run-2'}))['matchesCurrentWorkspace'])
