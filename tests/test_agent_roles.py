import base64
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from integrations.openjiuwen.agent_roles import load_bundle_role, load_role, ROLE_ROOT
from integrations.openjiuwen.bundle_agent import run_bundle


class RolePermissionTests(unittest.TestCase):
    def test_unified_roles_keep_scanner_and_contract_suite(self):
        diagnosis = load_bundle_role('ANALYZE')
        migration = load_bundle_role('GENERATE')
        self.assertIn('run_scanner', diagnosis.definition['tools'])
        self.assertIn('run_mcp_contract_suite', migration.definition['conditionalTools'])
        diagnosis.validate_tools(diagnosis.definition['tools'])
        migration.validate_tools(migration.definition['tools'] + ['run_mcp_contract_suite'])
        with self.assertRaises(ValueError):
            load_role('diagnosis', profile='source-analysis')

    def test_adjustment_combines_guidance_in_one_engineering_role(self):
        role = load_bundle_role('REPAIR', adjustment_capabilities=['document', 'tool', 'runtime'])
        self.assertEqual(role.role, 'adjustment')
        role.validate_tools(role.definition['tools'])
        resources = [item['path'] for item in role.resources]
        for skill in ['skill-optimization', 'tool-optimization', 'runtime-adjustment', 'enterprise-standardization']:
            self.assertIn('skills/' + skill + '/SKILL.md', resources)
        self.assertIn('write_file', role.definition['tools'])
        with self.assertRaises(ValueError):
            role.validate_tools(role.definition['tools'] + ['bash'])
        for mode, capabilities in [('REVIEW', ['tool']), ('REPAIR', []), ('REPAIR', ['tool', 'tool']), ('REPAIR', ['unknown'])]:
            with self.assertRaises(ValueError):
                load_bundle_role(mode, adjustment_capabilities=capabilities)

    def test_modes_and_actual_tool_permissions_fail_closed(self):
        for mode in ['ANALYZE', 'REVIEW', 'GENERATE', 'REPAIR']:
            role = load_bundle_role(mode)
            role.validate_tools(role.definition['tools'])
            for extra in ['bash', 'skill_tool', 'write_file'] if mode in ['ANALYZE', 'REVIEW'] else ['bash', 'skill_tool']:
                with self.assertRaises(ValueError):
                    role.validate_tools(role.definition['tools'] + [extra])
        for mode, version in [('UNKNOWN', 'v1'), ('GENERATE', '../v1')]:
            with self.assertRaises(ValueError):
                load_bundle_role(mode, version)

    def test_guidance_cannot_expand_code_permission_ceiling(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            version = root / 'v1'
            version.mkdir()
            manifest = json.loads((ROLE_ROOT / 'v1' / 'roles.json').read_text(encoding='utf-8'))
            manifest['roles']['diagnosis']['tools'].append('write_file')
            (version / 'roles.json').write_text(json.dumps(manifest), encoding='utf-8')
            with patch('integrations.openjiuwen.agent_roles.ROLE_ROOT', root), self.assertRaises(ValueError):
                load_bundle_role('ANALYZE')


class ReviewCompositionTests(unittest.IsolatedAsyncioTestCase):
    async def test_preparation_reuses_engineering_executor_and_discards_model_authored_receipts(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations' / 'openjiuwen'))
        self.addCleanup(sys.path.pop, 0)
        encoded = {'main.py': base64.b64encode(b'print(1)').decode()}
        expected = {'status': 'PRODUCED', 'preparation': {'summary': 'Read project', 'skills': [],
            'entrypoints': ['python main.py'], 'missing': [], 'baselinePlan': 'Needs business cases'},
            'executions': [{'status': 'COMPLETED', 'output': 'invented'}]}

        def writer(**options):
            names = [tool.card.name for tool in options['tools']]
            self.assertIn('write_file', names)
            self.assertIn('run_project_command', names)
            self.assertNotIn('compile_source', names)
            self.assertNotIn('run_scanner', names)
            async def stream(_):
                yield {'type': 'answer', 'payload': {'output': json.dumps(expected), 'result_type': 'answer'}}
            return SimpleNamespace(stream=stream)

        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text('{}', encoding='utf-8')
            protocol = io.StringIO()
            body = {'runId': 'preparation-fixture', 'assetDigest': 'base', 'files': encoded,
                    'model': {'modelId': 'model'}, 'bundle': {'mode': 'PREPARE', 'source': {'files': encoded}}}
            with patch.dict(os.environ, {'FINANCE_RUNTIME_CONFIG': str(config)}), \
                    patch('model_config.resolve_model', return_value={'apiKey': 'TEST_SECRET', 'baseUrl': 'http://unused'}), \
                    patch('model_config.request_settings', return_value={'model_name': 'model'}), \
                    patch('model_config.bind_agent_request_extensions', side_effect=lambda model, *_: model), \
                    patch('openjiuwen.core.foundation.llm.init_model', return_value=object()), \
                    patch('openjiuwen.harness.factory.create_deep_agent', side_effect=writer):
                await run_bundle(body, protocol)
            result = next(json.loads(line)['result'] for line in protocol.getvalue().splitlines() if 'result' in json.loads(line))
            self.assertEqual(result['status'], 'PRODUCED', result)
            self.assertEqual(result['files'], encoded)
            self.assertEqual(result['payload']['executions'], [])
            self.assertEqual(result['composition']['role'], 'runtime-preparation')

    async def test_independent_review_loads_its_guidance_and_never_offers_write_tools(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations' / 'openjiuwen'))
        self.addCleanup(sys.path.pop, 0)
        encoded = {'SKILL.md': base64.b64encode(b'Original business behavior').decode()}
        expected = {'status': 'ABSTAINED', 'reason': 'Missing requirement evidence'}

        def explorer(**options):
            names = [tool.card.name for tool in options['tools']]
            self.assertNotIn('write_file', names)
            self.assertNotIn('edit_file', names)
            self.assertNotIn('compile_source', names)
            self.assertNotIn('bash', names)
            self.assertIn('独立只读审查', options['system_prompt'])
            self.assertIn('CONFORMING', options['system_prompt'])
            async def stream(_):
                yield {'type': 'answer', 'payload': {'output': json.dumps(expected), 'result_type': 'answer'}}
            return SimpleNamespace(stream=stream)

        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text('{}', encoding='utf-8')
            protocol = io.StringIO()
            body = {'runId': 'role-review-fixture', 'assetDigest': 'base', 'files': encoded,
                    'model': {'modelId': 'model'}, 'bundle': {'mode': 'REVIEW', 'source': {'files': encoded}}}
            with patch.dict(os.environ, {'FINANCE_RUNTIME_CONFIG': str(config)}), \
                    patch('model_config.resolve_model', return_value={'apiKey': 'TEST_SECRET', 'baseUrl': 'http://unused'}), \
                    patch('model_config.request_settings', return_value={'model_name': 'model'}), \
                    patch('model_config.bind_agent_request_extensions', side_effect=lambda model, *_: model), \
                    patch('openjiuwen.core.foundation.llm.init_model', return_value=object()), \
                    patch('openjiuwen.harness.subagents.explore_agent.create_explore_agent', side_effect=explorer), \
                    patch('openjiuwen.harness.factory.create_deep_agent') as writer:
                await run_bundle(body, protocol)
                writer.assert_not_called()
            result = next(json.loads(line)['result'] for line in protocol.getvalue().splitlines() if 'result' in json.loads(line))
            self.assertEqual(result['status'], 'ABSTAINED', result)
            self.assertEqual(result['files'], {})
            self.assertEqual(result['composition']['role'], 'standardization-review')
            self.assertNotIn('TEST_SECRET', json.dumps(result['composition']))
            self.assertNotIn('Original business behavior', json.dumps(result['composition']))
