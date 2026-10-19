import base64
import copy
import hashlib
import io
import tempfile
import unittest
import zipfile
import json
import os
import sys
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch
from .bundle_runtime import hydrate_bundle, files_digest
from .instance_manager import InstanceManager
from .bundle_agent import collect_candidate
from .bundle_agent import run_bundle
from .execution_paths import execution_paths


def fixture():
    files = {'skills/budget/SKILL.md': b'---\nname: budget\ndescription: Budget\n---\nBudget body',
             'skills/rules/SKILL.md': b'---\nname: rules\ndescription: Rules\n---\nRules body',
             'shared/data.bin': bytes([0, 255, 128])}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as zipped:
        for name, content in files.items():
            zipped.writestr(name, content)
    archive = buffer.getvalue()
    members = [{'id': name, 'skillId': name, 'version': 'r1', 'skillFile': 'skills/' + name + '/SKILL.md',
                'artifactSha256': files_digest({p: content for p, content in files.items() if p.startswith('skills/' + name + '/')})}
               for name in ['budget', 'rules']]
    bundle = {'digest': files_digest(files), 'members': members, 'archiveBase64': base64.b64encode(archive).decode(),
              'archiveSha256': hashlib.sha256(archive).hexdigest()}
    return files, {'schemaVersion': 'finance.skill-eval.runtime-instance.v2', 'runId': 'bundle-run', 'side': 'right',
        'modelId': 'test', 'skill': None, 'bundle': bundle, 'variant': {'mode': 'skill_version'},
        'environment': {}, 'configuration': {}, 'secrets': {'mode': 'inline', 'values': {}}, 'limits': {'timeoutMs': 10000}}


class BundleRuntimeTest(unittest.TestCase):
    def test_runtime_materialization_preserves_windows_line_endings_and_binary(self):
        files, request = fixture()
        hydrate_bundle(request, InstanceManager())
        skill = request['skill']
        skill['files']['shared/windows.txt'] = 'first\r\nsecond\r\n'
        with ExitStack() as stack:
            _, root, _ = execution_paths(stack, {}, skill)
            self.assertEqual((root / 'shared/windows.txt').read_bytes(), b'first\r\nsecond\r\n')
            self.assertEqual((root / 'shared/data.bin').read_bytes(), files['shared/data.bin'])

    def test_real_archive_preserves_all_members_shared_binary_and_execution_identity(self):
        files, request = fixture()
        manager = InstanceManager()
        instance = manager.create(request, 'key')
        body = manager.execution(instance['instanceId'], {'schemaVersion': 'finance.skill-eval.runtime-case.v1', 'caseId': 'case', 'query': 'use both', 'workspaceFiles': []})
        self.assertEqual(len(body['skill']['bundleMembers']), 2)
        self.assertEqual(body['skill']['files']['skills/rules/SKILL.md'], files['skills/rules/SKILL.md'].decode())
        self.assertEqual(base64.b64decode(body['skill']['binaryFiles']['shared/data.bin']), files['shared/data.bin'])
        self.assertEqual(body['bundle']['digest'], files_digest(files))
        self.assertEqual(instance['instanceId'], manager.create(request, 'key')['instanceId'])

    def test_rejects_missing_member_and_forged_content_before_execution(self):
        for mutation in ['missing', 'digest', 'entry', 'version']:
            _, request = fixture()
            if mutation == 'missing':
                request['bundle']['members'].pop()
            elif mutation == 'digest':
                request['bundle']['members'][0]['artifactSha256'] = 'a' * 64
            elif mutation == 'version':
                request['bundle']['members'][0]['version'] = ''
            else:
                request['bundle']['entryInstructionsFile'] = '../outside'
            with self.assertRaises(ValueError, msg=mutation):
                hydrate_bundle(request, InstanceManager())

    def test_full_candidate_collection_keeps_skill_directory_and_unchanged_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files, _ = fixture()
            for name, content in files.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            collected = collect_candidate(root)
            self.assertEqual(set(collected), set(files))
            self.assertEqual(base64.b64decode(collected['shared/data.bin']), files['shared/data.bin'])


class BundleAgentWorkspaceTest(unittest.IsolatedAsyncioTestCase):
    async def test_real_file_tools_edit_multiple_members_but_reject_source_writes(self):
        # Only model execution is substituted; workspace and SDK tools are real.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        self.addCleanup(sys.path.pop, 0)
        from openjiuwen.harness.tools import WriteFileTool, ReadFileTool
        files, request = fixture()
        encoded = {name: base64.b64encode(content).decode() for name, content in files.items()}
        owner = self
        observations = []

        def agent_factory(**options):
            root = Path(options['workspace'])
            writer = next(tool for tool in options['tools'] if isinstance(tool, WriteFileTool))
            reader = next(tool for tool in options['tools'] if isinstance(tool, ReadFileTool))

            class Agent:
                async def invoke(self, _):
                    for name in ['budget', 'rules']:
                        relative = 'skills/' + name + '/SKILL.md'
                        before = await reader.invoke({'file_path': str(root / 'source' / relative)})
                        observations.append(str(before))
                        owner.assertTrue(before.success)
                        denied = await writer.invoke({'file_path': str(root / 'source' / relative), 'content': 'forbidden'})
                        owner.assertFalse(denied.success)
                        await reader.invoke({'file_path': str(root / 'candidate' / relative)})
                        result = await writer.invoke({'file_path': str(root / 'candidate' / relative), 'content': files[relative].decode() + '\nRepaired'})
                        observations.append(str(result))
                        owner.assertTrue(result.success, str(result))
                        owner.assertEqual((root / 'source' / relative).read_bytes(), files[relative])
                    return {'output': json.dumps({'status': 'PRODUCED', 'delivery': {'summary': 'Two members repaired', 'services': []}})}
            return Agent()

        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text('{}', encoding='utf-8')
            protocol = io.StringIO()
            body = {'runId': 'fixture', 'assetDigest': request['bundle']['digest'], 'files': encoded,
                    'model': {'modelId': 'fixture'}, 'bundle': {'mode': 'REPAIR', 'source': {'files': encoded}}}
            with patch.dict(os.environ, {'FINANCE_RUNTIME_CONFIG': str(config)}), \
                    patch('model_config.resolve_model', return_value={'apiKey': 'fixture', 'baseUrl': 'http://localhost/unused'}), \
                    patch('model_config.request_settings', return_value={'model_name': 'fixture'}), \
                    patch('model_config.bind_agent_request_extensions', side_effect=lambda model, *_: model), \
                    patch('openjiuwen.core.foundation.llm.init_model', return_value=object()), \
                    patch('openjiuwen.harness.subagents.code_agent.create_code_agent', side_effect=agent_factory):
                await run_bundle(body, protocol)
            result = json.loads(protocol.getvalue())['result']
            self.assertEqual(result['status'], 'PRODUCED', [result, observations])
            self.assertEqual(set(result['files']), set(files))
            for name in ['budget', 'rules']:
                self.assertTrue(base64.b64decode(result['files']['skills/' + name + '/SKILL.md']).endswith(b'Repaired'))
            self.assertEqual(base64.b64decode(result['files']['shared/data.bin']), files['shared/data.bin'])


if __name__ == '__main__':
    unittest.main()
