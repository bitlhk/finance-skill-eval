import asyncio
import base64
from copy import deepcopy
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from api.contracts import parse
from assets.runtime_skills import from_files
from assets.snapshot import make_snapshot
from runtime.comparison import comparison_runtimes


class ComparisonToolEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    def configuration(self):
        return {'runtime': {'type': 'runtime_launcher', 'environmentId': 'left'}, 'evaluationMode': 'solution_comparison',
            'timeoutMs': 60000, 'runtimeBindings': {'left': {'environmentId': 'left', 'skillAssetId': 'left-asset'},
            'right': {'environmentId': 'right', 'skillAssetId': 'right-asset', 'runtimeInputs': {
                'USER_ID': {'value': 'U001'}, 'API_KEY': {'secretEnv': 'ACCEPTANCE_SERVICE_KEY'}}}}}

    async def assemble(self, capability=True, instructions='# Service task'):
        raw = base64.b64encode(b'---\nname: test\ndescription: use service\n---\nUse actual tools.').decode()
        frozen = make_snapshot({'SKILL.md': raw}, 'one')
        class Library:
            def __init__(self, _workspace):
                pass
            async def resolve(self, *_args, **_kwargs):
                return {'instructions': instructions, 'archive': frozen['files'], 'skillSet': from_files(frozen)}
        class Registry:
            async def require_available(self, identifier):
                return {'environmentId': identifier}
            async def resolve_launcher(self, selected):
                return {'launcher': {'baseUrl': 'http://127.0.0.1:5000/' + selected['environmentId'] + '/'}, 'mcpEnvironmentIds': []}
            async def inspect(self, _selected):
                return {'status': 'ready', 'capabilities': {'models': [{'modelId': 'same', 'upstreamModelId': 'same'}],
                    'features': {'toolEnvironment': capability}}}
        with TemporaryDirectory() as directory, patch('runtime.comparison.AssetLibrary', Library), patch.dict(
                'os.environ', {'ACCEPTANCE_SERVICE_KEY': 'not-in-job-configuration'}):
            pack = {'cases': [{'requiredTools': []}], 'variants': {s: {'mode': 'skill_version', 'artifactSha256': 'a' * 64} for s in ('left', 'right')},
                    'models': {'execution': {s: {'modelId': 'same'} for s in ('left', 'right')}}}
            configuration = self.configuration()
            configuration['runtimeMcpBindings'] = {'left': [], 'right': [{'assetDigest': 'a' * 64,
                'toolNames': ['actual_service'], 'filePaths': ['SKILL.md'], 'start': ['python', 'service.py']}]}
            return await comparison_runtimes(configuration, pack, {'dataDirectory': directory}, registry=Registry())

    async def test_each_side_resolves_its_own_safe_inputs_using_shared_runtime_capability(self):
        owners = await self.assemble()
        self.assertEqual(owners['left'].options['configuration'], {})
        self.assertEqual(owners['left'].options['secrets']['values'], {})
        right = owners['right'].options
        self.assertEqual(right['configuration'], {'tool.env.USER_ID': 'U001'})
        self.assertEqual(right['secrets']['values'], {'tool.env.API_KEY': 'not-in-job-configuration'})
        self.assertNotIn('not-in-job-configuration', str(self.configuration()))

    async def test_imported_skill_can_choose_selected_tools_without_test_prescribing_them(self):
        options = (await self.assemble())['right'].options['environment']
        self.assertEqual(options['availableToolNames'], ['actual_service'])
        self.assertEqual(options['candidateMcpServices'][0]['toolNames'], ['actual_service'])
        self.assertEqual(options['requiredToolNames'], [])
        options = (await self.assemble(instructions='---\nname: no-tools\nallowed-tools: []\n---\nText only.'))['right'].options['environment']
        self.assertEqual(options['candidateMcpServices'], [])

    async def test_archive_binding_is_translated_to_the_actual_mounted_collection(self):
        from integrations.openjiuwen.instance_manager import InstanceManager
        options = (await self.assemble())['right'].options
        manager = InstanceManager()
        instance = manager.create({'schemaVersion': 'finance.runtime-instance.v1', 'runId': 'run', 'side': 'right',
            'modelId': 'same', 'configuration': options['configuration'], 'secrets': options['secrets'],
            'environment': options['environment'], 'limits': {'timeoutMs': 60000}, **options['skillSet']}, 'test')
        execution = manager.execution(instance['instanceId'], {'schemaVersion': 'finance.skill-eval.runtime-case.v1',
            'caseId': 'actual-service', 'query': 'Use the real service', 'workspaceFiles': []})
        self.assertNotEqual(options['variant']['artifactSha256'], execution['skill']['artifactSha256'])
        service = execution['environment']['candidateMcpServices'][0]
        self.assertEqual(service['assetDigest'], execution['skill']['artifactSha256'])
        self.assertEqual(service['assetDigest'], execution['variant']['artifactSha256'])
        self.assertTrue(all(path in execution['skill']['files'] for path in service['filePaths']))

    async def test_unsupported_runtime_does_not_silently_drop_inputs(self):
        with self.assertRaisesRegex(ValueError, 'toolEnvironment'):
            await self.assemble(capability=False)

    def test_public_contract_keeps_only_credential_references(self):
        value = parse('run_configuration', {'packId': 'pack', **self.configuration()})
        self.assertEqual(value['runtimeBindings']['right']['runtimeInputs']['API_KEY'], {'secretEnv': 'ACCEPTANCE_SERVICE_KEY'})
