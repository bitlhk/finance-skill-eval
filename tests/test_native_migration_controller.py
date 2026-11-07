import asyncio
import base64
from copy import deepcopy
import io
from tempfile import TemporaryDirectory
import unittest
import zipfile

import httpx
from api.server import create_application
from migration.service import MigrationTaskService


async def settled(client, identifier):
    for _ in range(200):
        response = await client.get('/api/migration-tasks/' + identifier)
        if response.status_code != 200:
            raise AssertionError(response.text)
        task = response.json()
        if task['attempts'] and task['attempts'][-1]['status'] != 'RUNNING':
            return task
        await asyncio.sleep(0.025)
    raise AssertionError('Migration did not settle')


class NativeMigrationControllerTests(unittest.IsolatedAsyncioTestCase):
    async def test_http_upload_task_wait_answer_git_publish_and_idempotency(self):
        calls = []
        async def agent(inputs, correlation, **_options):
            calls.append(deepcopy(inputs))
            if not inputs.get('taskSession', {}).get('answer'):
                return {'status': 'WAITING', 'interactions': [{'interaction_id': 'choice-one'}]}
            files = {**inputs['base']['files'], 'decision.txt': base64.b64encode(b'user selected scope').decode()}
            return {'status': 'PRODUCED', 'message': 'Changed according to user scope', 'files': files,
                'executions': [], 'deliveryReviews': [], 'evaluationRequested': False}
        with TemporaryDirectory() as directory:
            app = create_application({'dataDirectory': directory, 'accessToken': 'controlled', 'workspaceMode': 'single',
                'workspaceSubject': None, 'publicDemo': False})
            app.state.migration_service_factory = lambda config: MigrationTaskService(config, agent=agent, identity=lambda: 'controlled-judge')
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://platform',
                        headers={'Authorization': 'Bearer controlled'}) as client:
                    buffer = io.BytesIO()
                    with zipfile.ZipFile(buffer, 'w') as archive:
                        archive.writestr('nested/SKILL.md', '---\nname: policy\ndescription: test\n---\nOriginal policy')
                    asset = await client.post('/api/migration-tasks/assets', content=buffer.getvalue(), headers={'content-type': 'application/zip'})
                    self.assertEqual(asset.status_code, 200, asset.text)
                    created = await client.post('/api/migration-tasks', json={'sourceAssetIds': [asset.json()['assetId']], 'goal': 'Preserve capabilities'})
                    self.assertEqual(created.status_code, 200, created.text)
                    identifier = created.json()['id']
                    submitted = await client.post('/api/migration-tasks/' + identifier + '/conversation/message', json={'key': 'discuss', 'text': 'Please migrate'})
                    self.assertEqual(submitted.status_code, 202, submitted.text)
                    waiting = await settled(client, identifier)
                    self.assertEqual(waiting['attempts'][-1]['status'], 'WAITING', waiting['attempts'][-1])
                    answer = {'key': 'answer-once', 'attemptId': waiting['attempts'][-1]['id'], 'interactionId': 'choice-one', 'answers': {'scope': 'Keep business interface'}}
                    response = await client.post('/api/migration-tasks/' + identifier + '/conversation/answer', json=answer)
                    self.assertEqual(response.status_code, 202, response.text)
                    finished = await settled(client, identifier)
                    self.assertEqual(finished['attempts'][-1]['status'], 'COMPLETED', finished['attempts'][-1])
                    self.assertEqual(len(calls), 2)
                    self.assertEqual(len(finished['candidates']), 1)
                    again = await client.post('/api/migration-tasks/' + identifier + '/conversation/answer', json=answer)
                    self.assertEqual(again.status_code, 202, again.text)
                    self.assertEqual(len(calls), 2)
                    content = await client.get('/api/migration-tasks/' + identifier + '/file', params={'candidateId': finished['currentCandidateId'], 'path': 'decision.txt'})
                    self.assertEqual(content.json()['content'], 'user selected scope')
                    progress = (await client.get('/api/migration-tasks/' + identifier + '/activity')).json()
                    self.assertEqual(progress['status'], 'COMPLETED')

    async def test_complete_project_can_be_uploaded_without_a_skill_entry(self):
        with TemporaryDirectory() as directory:
            app = create_application({'dataDirectory': directory, 'accessToken': 'controlled', 'workspaceMode': 'single',
                'workspaceSubject': None, 'publicDemo': False})
            async with app.router.lifespan_context(app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://platform',
                        headers={'Authorization': 'Bearer controlled'}) as client:
                    buffer = io.BytesIO()
                    with zipfile.ZipFile(buffer, 'w') as archive:
                        archive.writestr('application/main.py', 'print("full agent")')
                    created = await client.post('/api/migration-tasks/upload', params={'inputKind': 'agent_project', 'projectNotes': 'Entrypoint is application/main.py'},
                        content=buffer.getvalue(), headers={'content-type': 'application/zip'})
                    self.assertEqual(created.status_code, 200, created.text)
                    self.assertEqual(created.json()['inputKind'], 'agent_project')
                    self.assertEqual(created.json()['source']['members'], [])
