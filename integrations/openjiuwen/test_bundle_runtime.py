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
from unittest.mock import patch, AsyncMock
from types import SimpleNamespace
from .bundle_runtime import files_digest, verify_bundle_integrity
from .skill_set import hydrate_skill_set
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
    skills=[{**member,'instructions':files[member['skillFile']].decode()} for member in members]
    return files, {'schemaVersion':'finance.skill-eval.runtime-instance.v2','runId':'bundle-run','side':'right','modelId':'test',
        'skills':skills,'contentDigest':files_digest(files),'assets':{'shared/data.bin':base64.b64encode(files['shared/data.bin']).decode()},
        'environment':{},'configuration':{},'secrets':{'mode':'inline','values':{}},'limits':{'timeoutMs':10000}}



class BundleRuntimeTest(unittest.TestCase):
    def test_one_member_uses_the_same_hydration_and_instance_contract(self):
        files, request = fixture()
        del files['skills/rules/SKILL.md']
        request['skills'] = request['skills'][:1]
        request['contentDigest']=files_digest(files)
        manager = InstanceManager()
        instance = manager.create(request, 'single-key')
        body = manager.execution(instance['instanceId'], {'schemaVersion': 'finance.skill-eval.runtime-case.v1', 'caseId': 'case', 'query': 'use budget', 'workspaceFiles': []})
        self.assertEqual(len(body['skill']['bundleMembers']), 1)
        self.assertEqual(body['bundle']['digest'], files_digest(files))

    def test_root_skill_accepts_optional_shared_assets_without_project_layout(self):
        instructions='Root Skill instructions'
        files={'SKILL.md':instructions.encode(),'rules.json':b'{"limit":100}'}
        request={'skills':[{'id':'root','skillId':'root','version':'r1','skillFile':'SKILL.md','instructions':instructions,
                           'artifactSha256':files_digest({'SKILL.md':instructions.encode()})}],
                 'assets':{'rules.json':base64.b64encode(files['rules.json']).decode()},'contentDigest':files_digest(files)}
        hydrate_skill_set(request,InstanceManager())
        self.assertEqual(request['skill']['files']['rules.json'],'{"limit":100}')

    def test_rejects_repaired_workspace_copy_even_when_loaded_package_is_unchanged(self):
        skill = {'bundleMembers': [{'skillId': 'test'}],
                 'files': {'shared/review.py': 'from decimal import ArithmeticError\n',
                           'fixtures/budgets.json': '{}'},
                 'binaryFiles': {'shared/data.bin': base64.b64encode(b'\0\xff').decode()}}
        inputs = [{'path': 'fixtures/budgets.json', 'content': '{"case":true}'}]
        with ExitStack() as stack:
            workspace, root, _ = execution_paths(stack, {}, skill, inputs)
            verify_bundle_integrity(skill, root, workspace, inputs)
            copied = workspace / 'shared/review.py'
            copied.parent.mkdir()
            copied.write_bytes((root / 'shared/review.py').read_bytes())
            verify_bundle_integrity(skill, root, workspace, inputs)
            copied.write_text('from decimal import Decimal\n', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'Frozen bundle copy was modified'):
                verify_bundle_integrity(skill, root, workspace, inputs)
            self.assertEqual((root / 'shared/review.py').read_text(), skill['files']['shared/review.py'])
            copied.write_bytes((root / 'shared/review.py').read_bytes())
            (root / 'shared/data.bin').write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError, 'Loaded bundle files were modified'):
                verify_bundle_integrity(skill, root, workspace, inputs)

    def test_runtime_materialization_preserves_windows_line_endings_and_binary(self):
        files, request = fixture()
        hydrate_skill_set(request, InstanceManager())
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
                request['skills'].pop()
            elif mutation == 'digest':
                request['skills'][0]['artifactSha256'] = 'a' * 64
            elif mutation == 'version':
                request['skills'][0]['version'] = ''
            else:
                request['entryInstructionsFile'] = '../outside'
            with self.assertRaises(ValueError, msg=mutation):
                hydrate_skill_set(request, InstanceManager())

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
    async def test_analysis_uses_read_only_explorer_and_bounded_tool_free_format_repair(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        self.addCleanup(sys.path.pop, 0)
        from openjiuwen.harness.tools import WriteFileTool, EditFileTool
        files, request = fixture()
        encoded = {name: base64.b64encode(content).decode() for name, content in files.items()}
        expected = {'status': 'PRODUCED', 'analysis': {'summary': 'Original finding', 'changes': [], 'missing': []}}
        broken = json.dumps(expected)[:-1]
        model = SimpleNamespace(invoke=AsyncMock(return_value=SimpleNamespace(
            content=json.dumps(expected), tool_calls=[], finish_reason='stop', usage_metadata=None)))
        owner = self

        def explorer(**options):
            owner.assertFalse(any(isinstance(tool, (WriteFileTool, EditFileTool)) for tool in options['tools']))
            owner.assertIn('ANALYZE', options['system_prompt'])
            return SimpleNamespace(invoke=AsyncMock(return_value={'output': broken, 'result_type': 'answer'}))

        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text('{}', encoding='utf-8')
            protocol = io.StringIO()
            body = {'runId': 'analysis-fixture', 'assetDigest': request['contentDigest'], 'files': encoded,
                    'model': {'modelId': 'fixture'}, 'bundle': {'mode': 'ANALYZE', 'source': {'files': encoded}}}
            with patch.dict(os.environ, {'FINANCE_RUNTIME_CONFIG': str(config)}), \
                    patch('model_config.resolve_model', return_value={'apiKey': 'fixture', 'baseUrl': 'http://localhost/unused'}), \
                    patch('model_config.request_settings', return_value={'model_name': 'fixture'}), \
                    patch('model_config.bind_agent_request_extensions', side_effect=lambda model, *_: model), \
                    patch('openjiuwen.core.foundation.llm.init_model', return_value=model), \
                    patch('openjiuwen.harness.subagents.code_agent.create_code_agent') as coder, \
                    patch('openjiuwen.harness.subagents.explore_agent.create_explore_agent', side_effect=explorer):
                await run_bundle(body, protocol)
                coder.assert_not_called()
            result = json.loads(protocol.getvalue())['result']
            self.assertEqual(result['status'], 'PRODUCED', result)
            self.assertEqual(result['payload'], expected)
            self.assertEqual(result['files'], {})
            self.assertEqual(model.invoke.await_count, 1)
            self.assertNotIn('tools', model.invoke.call_args.kwargs)
            self.assertEqual(model.invoke.call_args.kwargs['messages'][1]['content'], broken)

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
            owner.assertFalse(any(tool.card.name == 'run_contract_test' for tool in options['tools']))
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
            body = {'runId': 'fixture', 'assetDigest': request['contentDigest'], 'files': encoded,
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
