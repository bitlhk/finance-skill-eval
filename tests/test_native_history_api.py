import base64
import hashlib
import io
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import zipfile
import httpx
from api.server import create_application


class HistoryApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_old_records_remain_readonly_and_download_original_bytes(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            task = root / 'migration-tasks/tasks/bundle-old.json'
            task.parent.mkdir(parents=True)
            raw = b'{"schemaVersion":"finance.skill-migration.task.v1","id":"bundle-old","name":"old"}'
            task.write_bytes(raw)
            snapshot = root / 'migration-tasks/snapshots/bundle-old/source.json'
            snapshot.parent.mkdir(parents=True)
            snapshot.write_text(json.dumps({'digest': 'original', 'files': {'SKILL.md': base64.b64encode(b'original').decode()}}))
            before = snapshot.read_bytes()
            app = create_application({'dataDirectory': directory, 'accessToken': 'controlled', 'workspaceMode': 'single',
                                      'workspaceSubject': None, 'publicDemo': False})
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://platform',
                                         headers={'Authorization': 'Bearer controlled'}) as client:
                records = (await client.get('/api/history/tasks')).json()
                self.assertEqual(records[0]['id'], 'bundle-old')
                self.assertTrue(records[0]['readOnly'])
                self.assertEqual((await client.get('/api/migration-tasks/bundle-old')).status_code, 409)
                self.assertEqual((await client.post('/api/migration-tasks/bundle-old/cancel')).status_code, 409)
                self.assertEqual((await client.delete('/api/history/tasks/bundle-old')).status_code, 409)
                detail = (await client.get('/api/history/tasks/bundle-old')).json()
                self.assertEqual(detail['snapshots'][0]['revision'], 'source')
                result = await client.get('/api/history/tasks/bundle-old/file', params={'revision': 'source', 'path': 'SKILL.md'})
                self.assertEqual(result.json()['content'], 'original')
                result = await client.get('/api/history/tasks/bundle-old/archive')
                with zipfile.ZipFile(io.BytesIO(result.content)) as archive:
                    self.assertEqual(archive.read('record.json'), raw)
                    self.assertEqual(archive.read('snapshots/source.json'), before)
                    manifest = json.loads(archive.read('history-manifest.json'))
                    self.assertEqual(manifest['files']['record.json'], hashlib.sha256(raw).hexdigest())
            self.assertEqual(task.read_bytes(), raw)
            self.assertEqual(snapshot.read_bytes(), before)

    async def test_current_records_are_not_misclassified_as_history(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            file = root / 'migration-tasks/tasks/bundle-current.json'
            file.parent.mkdir(parents=True)
            file.write_text(json.dumps({'schemaVersion': 'finance.skill-migration.task.v3', 'id': 'bundle-current'}))
            app = create_application({'dataDirectory': directory, 'accessToken': 'controlled', 'workspaceMode': 'single',
                                      'workspaceSubject': None, 'publicDemo': False})
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://platform',
                                         headers={'Authorization': 'Bearer controlled'}) as client:
                self.assertEqual((await client.get('/api/history/tasks')).json(), [])
                self.assertEqual((await client.get('/api/history/tasks/bundle-current')).status_code, 409)
