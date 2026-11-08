import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from api.configuration import load_configuration
from api.identity import WorkspaceIdentity, AccessError, read_seed


class IdentityTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = load_configuration({'dataDirectory': str(self.root / 'data'), 'accessToken': 'controlled',
            'workspaceMode': 'single', 'publicDemo': False, 'workspaceSubject': None, 'workspaceOrigin': None})

    def account(self):
        seed = self.root / 'seed'
        (seed / 'skills').mkdir(parents=True)
        content = b'controlled-seed'
        (seed / 'skills' / 'initial.json').write_bytes(content)
        manifest = [{'path': 'skills/initial.json', 'sha256': hashlib.sha256(content).hexdigest()}]
        expected = hashlib.sha256(json.dumps(manifest, separators=(',', ':')).encode()).hexdigest()
        self.config.update(workspaceMode='account', workspaceOrigin='https://studio.example',
            workspaceSeedDirectory=str(seed), workspaceSeedSha256=expected)
        return WorkspaceIdentity(self.config)

    async def test_single_workspace_reuses_existing_token_and_root(self):
        identity = WorkspaceIdentity(self.config)
        with self.assertRaises(AccessError) as error:
            await identity.resolve('GET', '/api/catalog', {})
        self.assertEqual(error.exception.status, 401)
        context = await identity.resolve('GET', '/api/catalog', {'authorization': 'bearer controlled'})
        self.assertEqual(context['dataDirectory'], self.config['dataDirectory'])
        await identity.resolve('GET', '/api/health', {})

    async def test_owner_and_origin_are_required_without_changing_the_identity_scheme(self):
        self.config.update(workspaceSubject='studio_owner', workspaceOrigin='https://studio.example')
        identity = WorkspaceIdentity(self.config)
        headers = {'authorization': 'Bearer controlled', 'x-demo-user': 'studio_other', 'origin': 'https://studio.example'}
        with self.assertRaises(AccessError) as error:
            await identity.resolve('POST', '/api/runs', headers)
        self.assertEqual(error.exception.code, 'WORKSPACE_OWNER_REQUIRED')
        headers['x-demo-user'] = 'studio_owner'
        headers['origin'] = 'https://other.example'
        with self.assertRaises(AccessError) as error:
            await identity.resolve('POST', '/api/runs', headers)
        self.assertEqual(error.exception.code, 'WORKSPACE_ORIGIN_REQUIRED')

    async def test_account_workspaces_reuse_legacy_paths_and_preserve_data(self):
        identity = self.account()
        headers = {'authorization': 'Bearer controlled', 'x-demo-user': 'studio_alice', 'origin': 'https://studio.example'}
        alice = await identity.resolve('GET', '/api/catalog', headers)
        expected = self.root / 'data/account-workspaces' / hashlib.sha256(b'studio_alice').hexdigest()
        self.assertEqual(Path(alice['dataDirectory']), expected)
        self.assertEqual((expected / 'skills/initial.json').read_bytes(), b'controlled-seed')
        (expected / 'business-record.json').write_text('preserved')
        restarted = WorkspaceIdentity(self.config)
        again = await restarted.resolve('GET', '/api/catalog', headers)
        self.assertEqual(again['dataDirectory'], alice['dataDirectory'])
        self.assertEqual((expected / 'business-record.json').read_text(), 'preserved')
        bob = await restarted.resolve('GET', '/api/catalog', {**headers, 'x-demo-user': 'studio_bob'})
        self.assertNotEqual(bob['dataDirectory'], alice['dataDirectory'])
        self.assertFalse((Path(bob['dataDirectory']) / 'business-record.json').exists())

    async def test_existing_owner_keeps_original_data_directory(self):
        self.config['workspaceSubject'] = 'studio_owner'
        identity = self.account()
        result = await identity.resolve('GET', '/api/catalog', {'authorization': 'Bearer controlled', 'x-demo-user': 'studio_owner'})
        self.assertEqual(result['dataDirectory'], self.config['dataDirectory'])

    async def test_encoded_api_paths_cannot_skip_authorization(self):
        with self.assertRaises(AccessError) as error:
            await WorkspaceIdentity(self.config).resolve('GET', '/ap%69/catalog', {})
        self.assertEqual(error.exception.status, 401)

    async def test_saturated_work_budget_still_allows_cancel_and_reads(self):
        self.config['workspaceRequestLimits'] = {'perAccount': 1, 'global': 1, 'windowSeconds': 60}
        identity = self.account()
        headers = {'authorization': 'Bearer controlled', 'x-demo-user': 'studio_alice', 'origin': 'https://studio.example'}
        await identity.resolve('POST', '/api/runs', headers)
        with self.assertRaises(AccessError) as error:
            await identity.resolve('POST', '/api/runs', headers)
        self.assertEqual(error.exception.status, 429)
        await identity.resolve('GET', '/api/runs', headers)
        await identity.resolve('POST', '/api/runs/run-one/cancel', headers)

    def test_seed_digest_and_scope_are_enforced(self):
        identity = self.account()
        with self.assertRaises(AccessError):
            read_seed(self.config['workspaceSeedDirectory'], '0' * 64)
        (Path(self.config['workspaceSeedDirectory']) / 'migration-tasks').mkdir()
        with self.assertRaises(AccessError) as error:
            read_seed(self.config['workspaceSeedDirectory'], self.config['workspaceSeedSha256'])
        self.assertEqual(error.exception.code, 'WORKSPACE_SEED_CONTENT_NOT_ALLOWED')
