from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
import asyncio
import httpx

from api.server import create_application
from runtime.environments import EnvironmentStore


class EnvironmentApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_endpoints_preserve_dependencies_archive_and_identity(self):
        with TemporaryDirectory() as directory:
            app = create_application({'dataDirectory': directory, 'accessToken': 'controlled', 'workspaceMode': 'single',
                'workspaceSubject': None, 'publicDemo': False})
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://platform',
                    headers={'Authorization': 'Bearer controlled'}) as client:
                created = await client.post('/api/environments', json={'name': ' Native ', 'type': 'runtime_launcher',
                    'runtimeType': 'openjiuwen', 'baseUrl': 'http://127.0.0.1:12345/runtime'})
                self.assertEqual(created.status_code, 200, created.text)
                launcher = created.json()
                identifier = launcher['environmentId']
                self.assertEqual(launcher['baseUrl'], 'http://127.0.0.1:12345/runtime/')
                self.assertEqual(launcher['name'], 'Native')
                self.assertFalse(launcher['archived'])
                combined = await client.post('/api/environments', json={'name': 'Execution', 'type': 'execution_environment',
                    'launcherEnvironmentId': identifier})
                self.assertEqual(combined.status_code, 200, combined.text)
                self.assertEqual((await client.delete('/api/environments/' + identifier)).status_code, 409)
                self.assertEqual((await client.put('/api/environments/' + identifier, json={'name': 'bad',
                    'type': 'mcp_streamable_http', 'endpoint': 'http://127.0.0.1/mcp'})).status_code, 409)
                await client.patch('/api/environments/' + identifier + '/archive', json={'archived': True})
                listed = (await client.get('/api/environments')).json()
                self.assertNotIn(identifier, [item['environmentId'] for item in listed])
                self.assertEqual(len((await client.get('/api/environments?includeArchived=true')).json()), 2)
                blocked = await client.post('/api/environments/' + combined.json()['environmentId'] + '/preflight')
                self.assertEqual(blocked.status_code, 409, blocked.text)
                await client.delete('/api/environments/' + combined.json()['environmentId'])
                self.assertEqual((await client.delete('/api/environments/' + identifier)).status_code, 204)

    async def test_registry_rejects_unsafe_urls_and_validates_live_capabilities(self):
        with TemporaryDirectory() as root:
            registry = EnvironmentStore(root)
            for endpoint in ('http://remote.example/', 'https://user:secret@remote.example/', 'https://remote.example/?query=1'):
                with self.assertRaises(ValueError):
                    await registry.mutate('create', value={'name': 'invalid', 'type': 'runtime_launcher',
                        'runtimeType': 'generic_http', 'baseUrl': endpoint})
            capabilities = __import__('json').loads((Path(__file__).parents[1] / 'contracts/runtime-launcher/examples/builder-capabilities.json').read_text())
            async def remote(request):
                self.assertEqual(request.url.path, '/v1/runtime-capabilities')
                return httpx.Response(200, json=capabilities)
            registry.transport = httpx.MockTransport(remote)
            record = await registry.mutate('create', value={'name': 'runtime', 'type': 'runtime_launcher',
                'runtimeType': 'generic_http', 'baseUrl': 'https://runtime.example/'})
            result = await registry.inspect(record)
            self.assertEqual(result['status'], 'ready', result)
            self.assertEqual(result['capabilities'], capabilities)

    async def test_concurrent_registries_do_not_drop_writes(self):
        with TemporaryDirectory() as root:
            first, second = EnvironmentStore(root), EnvironmentStore(root)
            records = await asyncio.gather(*(registry.mutate('create', value={'name': str(index),
                'type': 'mcp_streamable_http', 'endpoint': 'https://mcp.example/'})
                for index, registry in enumerate([first, second] * 6)))
            self.assertEqual(len({item['environmentId'] for item in records}), 12)
            self.assertEqual(len(await first.list()), 12)
