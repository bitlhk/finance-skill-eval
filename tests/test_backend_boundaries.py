"""Guard ownership of shared capabilities and stable backend entry points."""
import ast
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1] / 'src'


class BackendBoundariesTests(unittest.TestCase):
    def test_shared_evaluation_and_improvement_do_not_depend_on_migration_or_agent_framework(self):
        violations = []
        for package in ('evaluation', 'improvement'):
            for path in (ROOT / package).glob('*.py'):
                for node in ast.walk(ast.parse(path.read_text(encoding='utf-8'))):
                    if isinstance(node, ast.ImportFrom) and node.module and (
                            node.module.startswith(('integrations.', 'openjiuwen', 'migration'))):
                        violations.append(str(path.relative_to(ROOT)) + ': ' + node.module)
        self.assertEqual(violations, [])

    def test_application_host_is_independent_of_business_entry_points(self):
        source = (ROOT / 'tasks' / 'application_host.py').read_text(encoding='utf-8')
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.ImportFrom):
                self.assertFalse((node.module or '').startswith(('migration', 'evaluation', 'integrations')))

    def test_existing_cli_entries_forward_to_single_implementations(self):
        for name in ('assets/snapshot_entry.py', 'runtime/builder_command_entry.py'):
            source = (ROOT / name).read_text(encoding='utf-8')
            tree = ast.parse(source)
            self.assertFalse(any(isinstance(node, (ast.FunctionDef, ast.ClassDef)) for node in tree.body))
            self.assertTrue(any(isinstance(node, ast.ImportFrom) and any(alias.name == 'main' for alias in node.names) for node in tree.body))
        for old in ('task_store.py', 'optimization_policy.py', 'evaluation_checks.py', 'asset_store.py'):
            self.assertFalse((ROOT / old).exists())

    def test_agent_guidance_has_one_backend_owned_location(self):
        project = ROOT.parent
        self.assertTrue((ROOT / 'resources' / 'agents' / 'v1' / 'roles.json').is_file())
        self.assertFalse((project / 'agent-roles').exists())
        self.assertFalse((project / 'src' / 'agent-roles').exists())
        self.assertFalse((ROOT / 'finance_skill_eval').exists())

    def test_model_transport_belongs_to_the_sdk_in_python(self):
        self.assertEqual(list(ROOT.rglob('*.ts')), [])
        self.assertFalse((ROOT / 'api' / 'capability_service.py').exists())
        integrations = ROOT.parent / 'integrations' / 'openjiuwen'
        self.assertFalse((integrations / 'runtime_model_exchange.py').exists())
        for name in ('model_role_agent.py', 'optimization_agent.py', 'migration_runtime.py'):
            source = (integrations / name).read_text(encoding='utf-8')
            self.assertNotIn("bridge.invoke('model'", source)
            self.assertNotIn('model_response', source)
        source = (ROOT / 'runtime' / 'models.py').read_text(encoding='utf-8')
        self.assertNotIn('import httpx', source)

    def test_public_entry_and_cli_use_python_and_shared_services(self):
        entry = (ROOT / 'api' / '__main__.py').read_text(encoding='utf-8')
        self.assertIn('create_application', entry)
        cli = (ROOT / 'api' / 'cli.py').read_text(encoding='utf-8')
        self.assertIn('EvaluationRunService', cli)
        for name in ('migration_routes.py', 'run_routes.py', 'improvement_routes.py'):
            self.assertTrue((ROOT / 'api' / name).is_file())
