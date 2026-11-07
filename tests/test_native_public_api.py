import io
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import zipfile
import httpx
from api.server import create_application


class PublicApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_static_auth_and_asset_upload_use_python_directly(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'web').mkdir()
            (root / 'web/index.html').write_text('<html>existing-theme</html>')
            app = create_application({'dataDirectory': str(root / 'data'), 'publicDirectory': str(root / 'web'),
                'accessToken': 'controlled', 'workspaceMode': 'single', 'workspaceSubject': None, 'publicDemo': False})
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://platform') as client:
                self.assertEqual((await client.get('/api/health')).status_code, 200)
                self.assertIn('existing-theme', (await client.get('/')).text)
                response = await client.post('/api/skills/upload', content=b'not authorized')
                self.assertEqual(response.status_code, 401)
                client.headers['Authorization'] = 'Bearer controlled'
                output = io.BytesIO()
                with zipfile.ZipFile(output, 'w') as archive:
                    archive.writestr('SKILL.md', '---\nname: example\ndescription: controlled\n---\nUse policy.')
                response = await client.post('/api/skills/upload', content=output.getvalue(), headers={'content-type': 'application/zip'})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()['skillId'], 'example')
                self.assertEqual(response.headers['cache-control'], 'no-store')
                self.assertIn('x-request-id', response.headers)
                self.assertEqual((await client.get('/api/not-an-endpoint')).status_code, 404)

    async def test_oversized_and_non_zip_uploads_are_rejected(self):
        with TemporaryDirectory() as root:
            app = create_application({'dataDirectory': root, 'accessToken': 'controlled', 'workspaceMode': 'single',
                                      'workspaceSubject': None, 'publicDemo': False})
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://platform',
                                         headers={'Authorization': 'Bearer controlled'}) as client:
                self.assertEqual((await client.post('/api/skills/upload', json={})).status_code, 400)
                response = await client.post('/api/skills/upload', content=b'x' * (8 * 1024 * 1024 + 1), headers={'content-type': 'application/zip'})
                self.assertEqual(response.status_code, 413, response.text)
