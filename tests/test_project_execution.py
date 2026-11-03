import asyncio
import base64
import hashlib
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

from integrations.openjiuwen.project_execution import execution_arguments, execute_project_command, snapshot_digest
from integrations.openjiuwen.agent_roles import load_bundle_role


class ProjectExecutionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations' / 'openjiuwen'))
        self.addCleanup(sys.path.pop, 0)
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name).resolve()
        (self.root / 'main.py').write_bytes(b'print(1)')

    def test_isolation_is_framework_neutral_and_cannot_mount_another_directory(self):
        args = execution_arguments(self.root, 'approved-image:1', 'test', ['python', 'main.py'], '.')
        self.assertIn('--network=none', args)
        self.assertIn('--pull=never', args)
        self.assertIn('--read-only', args)
        self.assertIn(f'type=bind,source={self.root},target=/input,readonly', args)
        self.assertEqual(args[-2:], ['python', 'main.py'])
        with self.assertRaises(ValueError):
            execution_arguments(self.root, 'approved-image:1', 'test', ['python'], '..')
        with self.assertRaises(ValueError):
            execution_arguments(self.root, '--privileged', 'test', ['python'], '.')
        self.assertEqual(snapshot_digest(self.root), hashlib.sha256(b'main.py\0print(1)\0').hexdigest())

    async def test_missing_environment_records_unavailable_without_running_host_code(self):
        with patch.dict(os.environ, {'FINANCE_EVAL_PROJECT_EXECUTION_IMAGE': ''}), \
                patch('asyncio.create_subprocess_exec') as spawn:
            result = await execute_project_command(self.root, ['python', 'main.py'])
        spawn.assert_not_called()
        self.assertEqual(result['status'], 'UNAVAILABLE')
        self.assertIsNone(result['exitCode'])
        self.assertEqual(result['snapshotDigest'], snapshot_digest(self.root))

    async def test_execution_records_real_exit_and_cleans_up_without_forwarding_service_secrets(self):
        calls = []
        class Process:
            returncode = None
            def __init__(self):
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_data(b'output\n')
                self.stdout.feed_eof()
            async def wait(self):
                self.returncode = 0
                return 0
            def kill(self):
                self.returncode = -9
        async def spawn(*args, **kwargs):
            calls.append((args, kwargs))
            return Process()
        with patch.dict(os.environ, {'FINANCE_EVAL_PROJECT_EXECUTION_IMAGE': 'approved:1', 'MODEL_API_KEY': 'secret'}), \
                patch('asyncio.create_subprocess_exec', side_effect=spawn):
            result = await execute_project_command(self.root, ['python', 'main.py'])
        self.assertEqual(result['status'], 'COMPLETED')
        self.assertEqual(result['output'], 'output\n')
        self.assertNotIn('MODEL_API_KEY', calls[0][1]['env'])
        self.assertEqual(calls[1][0][:3], ('docker', 'rm', '-f'))
        self.assertEqual((self.root / 'main.py').read_bytes(), b'print(1)')

    def test_preparation_has_generic_execution_but_no_migration_workflow_tools(self):
        role = load_bundle_role('PREPARE')
        role.validate_tools(role.definition['tools'])
        self.assertIn('run_project_command', role.definition['tools'])
        self.assertNotIn('run_scanner', role.definition['tools'])
        self.assertNotIn('compile_source', role.definition['tools'])


if __name__ == '__main__':
    unittest.main()
