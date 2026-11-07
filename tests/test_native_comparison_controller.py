import asyncio
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import httpx

from api.server import create_application
from evaluation.packs import EvalPackCatalog


class NativeComparisonControllerTests(unittest.IsolatedAsyncioTestCase):
    async def test_fixed_replay_report_and_rescore_through_public_http(self):
        root = Path(__file__).parents[1]
        pack = next(pack for pack in EvalPackCatalog(root).packs() if all(case.get('replay') for case in pack['cases'])
            and all(all(rule['allOf'] or rule['anyOf'] or rule['noneOf'] for rule in case['rubric']) for case in pack['cases']))
        with TemporaryDirectory() as directory:
            app = create_application({'rootDirectory': str(root), 'dataDirectory': directory, 'accessToken': 'controlled',
                'workspaceMode': 'single', 'workspaceSubject': None, 'publicDemo': False})
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://platform',
                        headers={'Authorization': 'Bearer controlled'}) as client:
                    response = await client.post('/api/runs', json={'packId': pack['packId'], 'runtime': {'type': 'replay'}, 'judgeMode': 'deterministic'})
                    self.assertEqual(response.status_code, 202, response.text)
                    identifier = response.json()['jobId']
                    for _ in range(200):
                        job = (await client.get('/api/runs/' + identifier)).json()
                        if job['status'] in ('completed', 'failed', 'interrupted', 'cancelled'):
                            break
                        await asyncio.sleep(.05)
                    self.assertEqual(job['status'], 'completed', job)
                    self.assertEqual(len(job['report']['cases']), len(pack['cases']))
                    self.assertTrue(all(case['judge'] is not None and case['left']['status'] == case['right']['status'] == 'completed' for case in job['report']['cases']))
                    original = job['report']['reportFingerprint']
                    reassessed = await client.post('/api/runs/' + identifier + '/rescore', json={'repetitions': 2})
                    self.assertEqual(reassessed.status_code, 200, reassessed.text)
                    self.assertEqual(reassessed.json()['repetitions'], 2)
                    saved = (await client.get('/api/runs/' + identifier)).json()
                    self.assertEqual(saved['report']['reportFingerprint'], original)
                    self.assertEqual(len(saved['rescorings']), 1)
                    markdown = await client.get('/api/runs/' + identifier + '/export?format=md')
                    self.assertIn('Skill 评测报告', markdown.text)
                    self.assertEqual((await client.post('/api/runs/' + identifier + '/retry')).status_code, 409)

    async def test_invalid_cross_runtime_configuration_is_rejected_before_execution(self):
        from evaluation.configuration import run_configuration
        with self.assertRaises(ValueError):
            run_configuration({'packId': 'irrelevant', 'runtime': {'type': 'replay'}, 'evaluationMode': 'candidate_runtime_comparison'})
        with self.assertRaises(ValueError):
            run_configuration({'packId': 'irrelevant', 'runtime': {'type': 'replay'}, 'executionRepetitions': 2})
