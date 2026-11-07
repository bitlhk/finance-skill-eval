import asyncio
import base64
from copy import deepcopy
import io
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch
import zipfile
import httpx

from api.configuration import load_configuration
from api.server import create_application
from assets.library import AssetLibrary
from improvement.service import OptimizationService
from integrations.openjiuwen.optimization_coordinator import OptimizationCoordinator
from runtime.environments import EnvironmentStore
from storage.jobs import JobStore
from tasks.values import fingerprint


async def coordinator(body, output, *, invoke):
    agent = OptimizationCoordinator(body['state'], body['baseline'], invoke, body.get('resume'))
    await agent.initialize()
    while not agent.terminal:
        await {'DIAGNOSIS': agent.diagnose, 'ADJUSTMENT': agent.adjust,
            'EVALUATION': agent.evaluate, 'REVIEW': agent.review}[agent.phase]()
    return agent.state


def complete_job(identifier, asset, passed=False):
    variant = {'mode': 'skill_version', 'skillId': asset['skillId'], 'version': asset['version'], 'artifactSha256': asset['artifactSha256']}
    execution = {'status': 'completed', 'output': 'correct' if passed else 'real defect', 'toolCalls': [],
        'runtimeIdentityVerified': True, 'streamCompleted': True, 'metadata': {'skillArtifactSha256': asset['artifactSha256']}}
    case = {'caseId': 'business-one', 'prompt': 'Apply the policy', 'left': deepcopy(execution), 'right': deepcopy(execution),
        'judge': {'dimensions': [{'rightScore': 5 if passed else 1, 'leftScore': 1}], 'summary': 'fixed' if passed else 'missing policy'}}
    return {'jobId': identifier, 'status': 'completed', 'createdAt': '2026-11-06T00:00:00Z', 'updatedAt': '2026-11-06T00:00:00Z',
        'configuration': {'packId': 'business', 'runtime': {'type': 'runtime_launcher', 'environmentId': 'environment-controlled'},
            'executionRepetitions': 1, 'includeHoldout': False},
        'report': {'cases': [case], 'models': {'execution': {side: {'providerId': 'controlled', 'modelId': 'same'} for side in ('left', 'right')}},
            'variants': {'left': variant, 'right': variant}}, 'evaluationSpec': {'cases': [{'caseId': 'business-one'}]}}


class Runs:
    def __init__(self, configuration):
        self.library = AssetLibrary(configuration)
        self.environments = EnvironmentStore(configuration['dataDirectory'])
        self.jobs = JobStore(configuration['dataDirectory'])
        self.catalog = self
        self.pack = {'packId': 'business', 'cases': [{'caseId': 'business-one'}]}
        self.created = []

    def get(self, identifier):
        if identifier == 'business':
            return deepcopy(self.pack)
        return self._get(identifier)

    async def _get(self, identifier):
        return deepcopy(self.jobs.get(identifier))

    async def create(self, configuration, questions=None):
        self.created.append(deepcopy(configuration))
        asset = await self.library.call('get', id=configuration['skillAssetId'])
        job = complete_job('run-candidate', asset, True)
        job['configuration'] = deepcopy(configuration)
        self.jobs.save(job)
        return job

    async def cancel(self, identifier):
        job = await self._get(identifier)
        job['status'] = 'cancelled'
        self.jobs.save(job)

    async def close(self):
        pass


class NativeOptimizationTests(unittest.IsolatedAsyncioTestCase):
    async def test_public_http_defect_edit_retest_review_and_adopt_preserves_source(self):
        with TemporaryDirectory() as directory:
            configuration = load_configuration({'dataDirectory': directory, 'accessToken': 'controlled', 'publicDemo': False,
                'workspaceMode': 'single', 'workspaceSubject': None})
            runs = Runs(configuration)
            output = io.BytesIO()
            with zipfile.ZipFile(output, 'w') as archive:
                archive.writestr('SKILL.md', '---\nname: policy\nversion: 1.0\ndescription: business\n---\nMissing required rule')
            asset = await runs.library.call('upload', archive=base64.b64encode(output.getvalue()).decode())
            original_job = complete_job('run-original', asset)
            original_job['configuration'].update(runtimeBindings={side: {'environmentId': 'environment-controlled',
                'skillAssetId': asset['assetId'], 'runtimeInputs': {'TENANT': {'value': 'isolated-business'},
                'API_KEY': {'secretEnv': 'CONTROLLED_BUSINESS_KEY'}}} for side in ('left', 'right')},
                runtimeMcpBindings={side: [{'assetDigest': asset['artifactSha256'], 'toolNames': ['policy'],
                    'filePaths': ['SKILL.md'], 'start': ['python', 'old-server.py']}] for side in ('left', 'right')})
            original_job['configuration']['runtimeToolConfig'] = {
                'context': {'caller': {'type': 'string', 'env': 'BUSINESS_USER_ID'}},
                'providers': {}, 'tools': {'policy': {'contextBindings': {'X-User-Id': 'context.caller'}}}}
            runs.jobs.save(original_job)
            before = fingerprint(runs.jobs.get('run-original'))
            calls = []
            async def diagnostic(inputs):
                calls.append('diagnosis')
                self.assertEqual(inputs['cases'][0]['verdict'], 'FAIL')
                return {'judgement': {'status': 'PROPOSED', 'hypothesis': {'layer': 'SKILL', 'evidenceCaseIds': ['business-one']}}}
            async def engineer(root, session, source, current, goal, evaluations, **options):
                calls.append('edit')
                self.assertEqual(options['delivery_tools']['services'][0]['start'], ['python', 'old-server.py'])
                files = {**current, 'SKILL.md': base64.b64encode(b'---\nname: policy\nversion: 1.0\ndescription: business\n---\nApply required rule').decode()}
                return {'status': 'PRODUCED', 'files': files, 'summary': 'Repair omitted business rule', 'changed': ['SKILL.md'],
                    'deliveryTools': {'services': [{'toolNames': ['policy'], 'filePaths': ['SKILL.md'],
                        'start': ['python', 'new-server.py']}], 'tools': []}}
            async def reviewer(material, *_args):
                calls.append('review')
                self.assertEqual(material['evaluationSummary']['candidate']['passRate'], 1)
                return {'status': 'PRODUCED', 'review': {'recommendation': 'KEEP_CANDIDATE', 'reason': 'goal met',
                    'improvements': ['rule restored'], 'regressions': [], 'evidenceIds': ['business-one']}}
            app = create_application(configuration)
            app.state.run_services[directory] = runs
            app.state.improvement_service_factory = lambda config, run_service: OptimizationService(config, run_service,
                engineering=engineer, diagnostic=diagnostic, reviewer=reviewer, coordinator=coordinator)
            async with app.router.lifespan_context(app):
                with patch('improvement.service.configured_model_role', return_value={'configured': True, 'model': {'modelId': 'controlled'}}):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://platform', headers={'Authorization': 'Bearer controlled'}) as client:
                        response = await client.post('/api/runs/run-original/optimize', json={'maxRounds': 2, 'targetPassRate': 1})
                        self.assertEqual(response.status_code, 202, response.text)
                        identifier = response.json()['optimizationId']
                        for _ in range(200):
                            item = (await client.get('/api/optimizations/' + identifier)).json()
                            if item['status'] not in ('diagnosing', 'validating', 'reviewing', 'reevaluating'):
                                break
                            await asyncio.sleep(.02)
                        self.assertEqual(item['status'], 'review', item)
                        self.assertEqual(calls, ['diagnosis', 'edit', 'review'])
                        self.assertEqual(item['loop']['status'], 'REVIEW')
                        self.assertNotEqual(item['candidate']['assetId'], asset['assetId'])
                        rerun = runs.created[0]
                        self.assertEqual(rerun['runtimeToolConfig'], original_job['configuration']['runtimeToolConfig'])
                        self.assertEqual(rerun['runtimeBindings']['right']['runtimeInputs'], original_job['configuration']['runtimeBindings']['right']['runtimeInputs'])
                        self.assertEqual(rerun['runtimeBindings']['left']['runtimeInputs'], rerun['runtimeBindings']['right']['runtimeInputs'])
                        self.assertEqual(rerun['runtimeMcpBindings']['left'][0]['assetDigest'], asset['artifactSha256'])
                        self.assertEqual(rerun['runtimeMcpBindings']['right'][0]['assetDigest'], item['candidate']['artifactSha256'])
                        self.assertEqual(rerun['runtimeMcpBindings']['right'][0]['start'], ['python', 'new-server.py'])
                        self.assertEqual(rerun['runtimeMcpBindings']['left'][0]['start'], ['python', 'old-server.py'])
                        # The coordinator can stop after publishing a candidate,
                        # before advancing its stage. Recover that same round,
                        # without diagnosing/editing or rerunning the business.
                        from storage.tasks import write_json
                        instance = next(iter(app.state.improvement_services.values()))
                        for _ in range(100):
                            if not await instance.busy(identifier):
                                break
                            await asyncio.sleep(.01)
                        previous_job = item['rerunJobId']
                        item.update(status='interrupted', effectReview=None, reviewJobId=None, candidate=None)
                        item['loop'].update(status='INTERRUPTED', stage='ADJUSTMENT')
                        write_json(instance.path(identifier), item)
                        response = await client.post('/api/optimizations/' + identifier + '/recover')
                        self.assertEqual(response.status_code, 202, response.text)
                        for _ in range(200):
                            item = (await client.get('/api/optimizations/' + identifier)).json()
                            if item['status'] not in ('diagnosing', 'validating', 'reviewing', 'reevaluating'):
                                break
                            await asyncio.sleep(.02)
                        self.assertEqual(item['status'], 'review', item)
                        self.assertEqual(item['loop']['status'], 'REVIEW')
                        self.assertEqual(item['rerunJobId'], previous_job)
                        self.assertEqual(len(item['loop']['rounds']), 1)
                        self.assertEqual(calls, ['diagnosis', 'edit', 'review', 'review'])
                        adopted = await client.post('/api/optimizations/' + identifier + '/decision', json={'decision': 'adopt'})
                        self.assertEqual(adopted.status_code, 200, adopted.text)
                        self.assertEqual(adopted.json()['status'], 'adopted')
                        self.assertEqual(fingerprint(runs.jobs.get('run-original')), before)

    async def test_human_dispute_resolution_and_stale_annotations(self):
        from evaluation.human_review import HumanReviewStore, comparison_targets
        from storage.coordination import CoordinationConflict
        with TemporaryDirectory() as directory:
            material = {'digest': 'a' * 64, 'targets': comparison_targets({'cases': [{'caseId': 'one', 'judge': {'winner': 'left'}}]}),
                'resources': {'cases': [{'left': {'output': 'original evidence'}}]}}
            async def resolve(_source):
                return deepcopy(material)
            store = HumanReviewStore(directory, resolve)
            source = {'kind': 'comparison', 'id': 'run-one'}
            entries = [{'targetId': '/cases/0/judge/winner', 'reviewer': reviewer, 'outcome': outcome, 'reason': 'checked',
                'evidenceRefs': ['/cases/0/left/output']} for reviewer, outcome in [('a', 'left'), ('b', 'right')]]
            view = await store.append({'source': source, 'sourceDigest': material['digest'], 'entries': entries})
            self.assertTrue(view['consensus']['/cases/0/judge/winner']['disputed'])
            view = await store.append({'source': source, 'sourceDigest': material['digest'], 'entries': [{**entries[0],
                'kind': 'ADJUDICATION', 'reviewer': 'arbiter', 'resolves': [entry['id'] for entry in view['records']]}]})
            self.assertEqual(view['consensus']['/cases/0/judge/winner']['outcome'], 'left')
            material['digest'] = 'b' * 64
            self.assertEqual((await store.get(source))['staleRecordCount'], 3)
            with self.assertRaises(CoordinationConflict):
                await store.append({'source': source, 'sourceDigest': 'a' * 64, 'entries': entries})
