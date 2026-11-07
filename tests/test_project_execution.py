import asyncio
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, AsyncMock

from integrations.openjiuwen.project_execution import execution_arguments, execute_project_command, snapshot_digest, verifier_result, build_project_command_tool, spawn_wsl
from integrations.openjiuwen.agent_roles import load_bundle_role


class ProjectExecutionTests(unittest.IsolatedAsyncioTestCase):
    def test_verifier_result_decodes_only_successful_json_receipts(self):
        valid = verifier_result({'status': 'COMPLETED', 'output': '{"checks": []}'})
        self.assertEqual(valid['result'], {'checks': []})
        invalid = verifier_result({'status': 'COMPLETED', 'output': 'not-json'})
        self.assertEqual(invalid['status'], 'INVALID_OUTPUT')
        self.assertEqual(verifier_result({'status': 'COMPLETED', 'output': '{"score": NaN}'})['status'], 'INVALID_OUTPUT')
        failed = {'status': 'TIMEOUT', 'output': 'timed out'}
        self.assertEqual(verifier_result(failed), failed)

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
        self.assertIn('--env=HOME=/tmp/project/.home', args)
        self.assertIn('--env=XDG_CACHE_HOME=/tmp/project/.cache', args)
        self.assertIn('--env=XDG_DATA_HOME=/tmp/project/.local/share', args)
        self.assertIn('--pull=never', args)
        self.assertIn('--read-only', args)
        self.assertIn('--cap-drop=ALL', args)
        self.assertIn('--security-opt=no-new-privileges', args)
        self.assertIn('--bounding-set=-all', args[-5])
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

    async def test_native_api_import_does_not_require_a_script_directory_in_pythonpath(self):
        program = ('import asyncio,sys,json; from pathlib import Path; from runtime.project import execute_project_command; '
            'r=asyncio.run(execute_project_command(Path(sys.argv[1]),["python","main.py"])); print(json.dumps({"status":r["status"]}))')
        process = await asyncio.create_subprocess_exec(sys.executable, '-B', '-c', program, str(self.root), cwd=self.root,
            env={**os.environ, 'FINANCE_EVAL_PROJECT_EXECUTION_IMAGE': ''}, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        output, error = await asyncio.wait_for(process.communicate(), 30)
        self.assertEqual(process.returncode, 0, error.decode(errors='replace'))
        self.assertEqual(json.loads(output)['status'], 'UNAVAILABLE')

    async def test_null_optional_arguments_produce_valid_unavailable_receipt(self):
        receipts=[]
        with patch.dict(os.environ, {'FINANCE_EVAL_PROJECT_EXECUTION_IMAGE': ''}):
            result = await build_project_command_tool(self.root,receipts).invoke({'command':['python','main.py'],'cwd':None,'timeout_seconds':None})
        self.assertEqual(result['cwd'], '.')
        self.assertEqual(result['status'], 'UNAVAILABLE')
        self.assertIsNone(result['exitCode'])
        self.assertEqual(result['snapshotDigest'], snapshot_digest(self.root))
        self.assertEqual(receipts,[result])

    async def test_agent_command_receipts_have_distinct_stable_references(self):
        receipts=[]
        tool=build_project_command_tool(self.root,receipts)
        with patch.dict(os.environ, {'FINANCE_EVAL_PROJECT_EXECUTION_IMAGE': ''}):
            first=await tool.invoke({'command':['python','main.py']})
            second=await tool.invoke({'command':['python','main.py']})
        self.assertRegex(first['receiptId'],r'^project-check-[a-f0-9]{32}$')
        self.assertNotEqual(first['receiptId'],second['receiptId'])
        self.assertEqual(receipts,[first,second])

    @unittest.skipUnless(os.environ.get('FINANCE_TEST_REAL_DOCKER') == '1', 'requires an explicitly configured local Docker test')
    async def test_real_isolated_container_runs_project_without_network(self):
        (self.root / 'main.py').write_text(
            'import json, os\n'
            'caps = next(line.split()[1] for line in open("/proc/self/status") if line.startswith("CapEff:"))\n'
            'print(json.dumps({"ok": True, "uid": os.getuid(), "capabilities": caps, '
            '"interfaces": sorted(os.listdir("/sys/class/net"))}))\n', encoding='utf-8')
        receipt = await execute_project_command(self.root, ['python', 'main.py'], timeout_seconds=30)
        self.assertEqual(receipt['status'], 'COMPLETED', receipt['output'])
        self.assertEqual(receipt['exitCode'], 0)
        self.assertIn('"ok": true', receipt['output'])
        self.assertIn('"uid": 65534', receipt['output'])
        self.assertIn('"capabilities": "0000000000000000"', receipt['output'])
        self.assertIn('"interfaces": ["lo"]', receipt['output'])

    @unittest.skipUnless(os.environ.get('FINANCE_TEST_REAL_DOCKER') == '1', 'requires an explicitly configured local Docker test')
    async def test_real_verifier_cli_returns_json_from_isolated_container(self):
        script = ('import json\n'
                  'with open("evidence.json", encoding="utf-8") as f: data = json.load(f)\n'
                  'print(json.dumps({"checks": [{"id": "amount", "status": '
                  '"PASS" if data["amount"] == 42 else "FAIL", "reason": "verified", '
                  '"evidenceRefs": ["/amount"]}]}))\n')
        executable = Path(__file__).resolve().parents[1] / 'integrations' / 'openjiuwen' / 'project_execution.py'
        process = await asyncio.create_subprocess_exec(sys.executable, '-B', str(executable),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        output, error = await process.communicate(json.dumps({'script': script, 'resources': {'amount': 42}}).encode())
        self.assertEqual(process.returncode, 0, error.decode(errors='replace'))
        receipt = json.loads(output)
        self.assertEqual(receipt['status'], 'COMPLETED', receipt['output'])
        self.assertEqual(receipt['result']['checks'][0]['status'], 'PASS')

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
        with patch.dict(os.environ, {'FINANCE_EVAL_PROJECT_EXECUTION_IMAGE': 'approved:1', 'FINANCE_EVAL_DOCKER_WSL_DISTRIBUTION':'', 'MODEL_API_KEY': 'secret'}), \
                patch('asyncio.create_subprocess_exec', side_effect=spawn):
            result = await execute_project_command(self.root, ['python', 'main.py'])
        self.assertEqual(result['status'], 'COMPLETED')
        self.assertEqual(result['output'], 'output\n')
        self.assertNotIn('MODEL_API_KEY', calls[0][1]['env'])
        self.assertEqual(calls[1][0][:3], ('docker', 'rm', '-f'))
        self.assertEqual((self.root / 'main.py').read_bytes(), b'print(1)')

    async def test_wsl_driver_uses_same_isolation_and_cleanup(self):
        calls=[]
        class Process:
            returncode=None
            def __init__(self):
                self.stdout=asyncio.StreamReader();self.stdout.feed_data(b'ok\n');self.stdout.feed_eof()
            async def wait(self): self.returncode=0;return 0
            def kill(self): self.returncode=-9
        async def wsl_spawn(prefix,args,environment,stdout,stderr):
            calls.append((tuple([*prefix,*args]),{'env':environment}));return Process()
        driver=['wsl.exe','--distribution','Ubuntu','--user','root','--','docker']
        with patch.dict(os.environ,{'FINANCE_EVAL_PROJECT_EXECUTION_IMAGE':'approved:1','MODEL_API_KEY':'secret'}), \
             patch('integrations.openjiuwen.project_execution.docker_driver',new=AsyncMock(return_value=(driver,'/mnt/c/test-project'))), \
             patch('integrations.openjiuwen.project_execution.spawn_wsl',side_effect=wsl_spawn):
            result=await execute_project_command(self.root,['python','main.py'])
        self.assertEqual(result['status'],'COMPLETED')
        self.assertEqual(calls[0][0][:len(driver)],tuple(driver))
        self.assertIn('--network=none',calls[0][0])
        self.assertIn('type=bind,source=/mnt/c/test-project,target=/input,readonly',calls[0][0])
        self.assertEqual(calls[1][0][:len(driver)+2],tuple([*driver,'rm','-f']))
        self.assertNotIn('MODEL_API_KEY',calls[0][1]['env'])

    async def test_shared_temporary_mount_receives_only_a_frozen_project_copy(self):
        mounts = []
        class Process:
            returncode = None
            def __init__(self):
                self.stdout = asyncio.StreamReader()
                self.stdout.feed_eof()
            async def wait(self):
                self.returncode = 0
                return 0
            def kill(self):
                self.returncode = -9
        async def spawn(*args, **kwargs):
            if 'run' in args:
                mount = next(arg for arg in args if arg.startswith('type=bind,source='))
                path = Path(mount.removeprefix('type=bind,source=').removesuffix(',target=/input,readonly'))
                self.assertEqual(path.parent.parent, shared_root)
                self.assertEqual((path / 'main.py').read_bytes(), b'print(1)')
                self.assertNotEqual(path, self.root)
                (path / 'main.py').write_bytes(b'isolated edit')
                mounts.append(path)
            return Process()
        with tempfile.TemporaryDirectory() as shared:
            shared_root = Path(shared).resolve()
            with patch.dict(os.environ, {'TMPDIR': str(shared_root), 'FINANCE_EVAL_PROJECT_EXECUTION_IMAGE': 'approved:1',
                    'FINANCE_EVAL_DOCKER_WSL_DISTRIBUTION': ''}), patch('asyncio.create_subprocess_exec', side_effect=spawn):
                result = await execute_project_command(self.root, ['python', 'main.py'])
            self.assertEqual(result['status'], 'COMPLETED', result)
            self.assertEqual(result['snapshotDigest'], snapshot_digest(self.root))
            self.assertFalse(mounts[0].exists())
            self.assertEqual((self.root / 'main.py').read_bytes(), b'print(1)')

    async def test_wsl_bridge_transfers_arguments_as_data(self):
        class Input:
            value=b''
            def write(self,data): self.value+=data
            async def drain(self): pass
            def close(self): pass
        class Process:
            returncode=None
            def __init__(self): self.stdin=Input();self.input=self.stdin
        child=Process()
        arguments=['docker','run','sh','-c','printf "%s" "$1"','name','a b; $(touch forbidden)']
        with patch('asyncio.create_subprocess_exec',return_value=child) as spawn:
            await spawn_wsl(['wsl.exe','--'],arguments,{},asyncio.subprocess.PIPE,asyncio.subprocess.PIPE)
        self.assertEqual(spawn.call_args.args,('wsl.exe','--','python3','-'))
        payload=child.input.value.decode('ascii').split('base64.b64decode("',1)[1].split('"',1)[0]
        self.assertEqual(json.loads(base64.b64decode(payload)),arguments)

    def test_preparation_has_generic_execution_but_no_migration_workflow_tools(self):
        role = load_bundle_role('PREPARE')
        role.validate_tools(role.definition['tools'])
        self.assertIn('run_project_command', role.definition['tools'])
        self.assertNotIn('run_scanner', role.definition['tools'])
        self.assertNotIn('compile_source', role.definition['tools'])


if __name__ == '__main__':
    unittest.main()
