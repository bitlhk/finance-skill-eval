import os
from pathlib import Path
import sys
import tempfile
import unittest
from integrations.openjiuwen.command_runtime import command_environment, execute_command


class CommandRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_command_executes_script_with_business_stdin_and_plain_output(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'balance.py').write_text('import sys, pathlib\nprint(pathlib.Path.cwd().name)\nprint(sys.stdin.read())\n', encoding='utf-8')
            result = await execute_command(directory, [sys.executable, 'balance.py'], 'account-1')
            self.assertEqual(result['exitCode'], 0)
            self.assertIn(Path(directory).name, result['stdout'])
            self.assertIn('account-1', result['stdout'])

    async def test_nonzero_exit_and_stderr_are_command_results(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'fail.py').write_text('import sys\nprint("failure", file=sys.stderr)\nsys.exit(3)\n', encoding='utf-8')
            result = await execute_command(directory, [sys.executable, 'fail.py'])
            self.assertEqual(result['exitCode'], 3)
            self.assertIn('failure', result['stderr'])

    async def test_runtime_secrets_are_not_inherited(self):
        environment = command_environment({**os.environ, 'BUSINESS_APP_KEY':'secret', 'FINANCE_RUNTIME_CONFIG':'private', 'FINANCE_TOOL_CONTEXT_JSON':'identity'})
        self.assertNotIn('BUSINESS_APP_KEY', environment)
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'env.py').write_text('import os\nprint(os.getenv("BUSINESS_APP_KEY", "absent"))\n', encoding='utf-8')
            result = await execute_command(directory, [sys.executable, 'env.py'], environ={**os.environ, 'BUSINESS_APP_KEY':'secret'})
            self.assertEqual(result['stdout'].strip(), 'absent')

    async def test_timeout_and_output_limit_terminate_process(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, 'sleep.py').write_text('import time\ntime.sleep(20)\n', encoding='utf-8')
            with self.assertRaises(TimeoutError):
                await execute_command(directory, [sys.executable, 'sleep.py'], timeout=0.1)
            Path(directory, 'big.py').write_text('print("x" * 10000)\n', encoding='utf-8')
            with self.assertRaises(ValueError):
                await execute_command(directory, [sys.executable, 'big.py'], limit=100)

    async def test_invalid_program_and_stdin_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError): await execute_command(directory, ['cmd', '/c', 'echo secret'])
            with self.assertRaises(ValueError): await execute_command(directory, [], '')
            with self.assertRaises(ValueError): await execute_command(directory, [sys.executable], 'x' * 200, limit=100)


if __name__ == '__main__': unittest.main()
