import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import zipfile
import httpx

from api.server import create_application
from evaluation.case_generation import generate_cases
from evaluation.packs import EvalPackCatalog
from storage.repository import TaskRepository
from storage.coordination import CoordinationConflict


class DatasetTests(unittest.IsolatedAsyncioTestCase):
    async def test_catalog_upload_custom_dataset_and_import_use_existing_contracts(self):
        with TemporaryDirectory() as directory:
            app = create_application({'dataDirectory': directory, 'accessToken': 'controlled', 'workspaceMode': 'single',
                'workspaceSubject': None, 'publicDemo': False, 'rootDirectory': str(Path(__file__).parents[1])})
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://platform',
                headers={'Authorization': 'Bearer controlled'}) as client:
                output = io.BytesIO()
                with zipfile.ZipFile(output, 'w') as archive:
                    archive.writestr('SKILL.md', '---\nname: example\ndescription: controlled\nallowed-tools: []\n---\nUse policy.')
                skill = (await client.post('/api/skills/upload', content=output.getvalue(), headers={'content-type': 'application/zip'})).json()
                suite = {'name': 'User dataset', 'cases': [{'id': 'normal', 'input': 'A real user case', 'criteria': ['Business goal']}],
                    'holdoutCases': [{'id': 'holdout', 'input': 'Private holdout', 'criteria': ['Goal']} ]}
                response = await client.post('/api/skills/' + skill['assetId'] + '/prepare/import', json=suite)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()['cases'][0]['taskMode'], 'single_turn')
                self.assertEqual(len(response.json()['holdoutCases']), 1)
                catalog = await client.get('/api/catalog')
                self.assertEqual(catalog.status_code, 200, catalog.text)
                data = catalog.json()
                self.assertEqual(data['uploadedSkills'][0]['runtimeRequirements'], {'status': 'declared', 'tools': []})
                self.assertEqual(data['preparations'][0]['preparationId'], response.json()['preparationId'])
                self.assertGreater(len(data['evalPacks']), 0)

    async def test_more_than_eight_cases_are_complete_and_not_one_large_model_call(self):
        class Model:
            calls = []
            async def complete(self, request):
                material = json.loads(request['messages'][-1]['content'])
                self.calls.append(material)
                start = len(material.get('previousGeneratedCases', []))
                return {'content': json.dumps({'summary': 'Scenario coverage', 'cases': [{'caseId': str(index), 'name': str(index),
                    'prompt': 'Business task ' + str(index), 'evaluationGoal': 'Goal', 'requiredTools': [], 'rubric': []}
                    for index in range(start, start + material['maximumCases'])]})}
        model = Model()
        # Rubric must meet the same canonical schema as authored cases.
        from api.contracts import parse
        reference = EvalPackCatalog(Path(__file__).parents[1]).packs()[0]['cases'][0]
        original = model.complete
        async def answer(request):
            response = await original(request)
            value = json.loads(response['content'])
            for case in value['cases']:
                case['rubric'] = reference['rubric']
            return {'content': json.dumps(value)}
        model.complete = answer
        result = await generate_cases({'skillId': 'example', 'skillSource': 'Skill', 'count': 19}, adapter=model,
            model={'providerId': 'controlled', 'modelId': 'controlled', 'parameters': {}})
        self.assertEqual(len(result['cases']), 19)
        self.assertEqual([item['maximumCases'] for item in model.calls], [8, 8, 3])
        self.assertEqual(len({item['caseId'] for item in result['cases']}), 19)

    async def test_native_repository_preserves_ownership_and_serializes_replica_updates(self):
        import asyncio
        with TemporaryDirectory() as directory:
            first, second = TaskRepository(directory), TaskRepository(directory)
            identifier = 'bundle-aabbcc'
            await first.save({'schemaVersion': 'finance.skill-migration.task.v3', 'id': identifier, 'count': 0})
            def increment(task):
                task['count'] += 1
            await asyncio.gather(*(repository.update(identifier, increment) for repository in [first, second] * 6))
            self.assertEqual((await second.get(identifier))['count'], 12)
            async with first.ownership(identifier):
                # A separate request context cannot take over while its owner is alive.
                from contextvars import Context
                async def competing():
                    async with second.ownership(identifier):
                        pass
                with self.assertRaises(CoordinationConflict):
                    await asyncio.create_task(competing(), context=Context())
            async with second.ownership(identifier):
                await second.update(identifier, increment)
