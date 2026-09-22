"""No model/provider dependencies: candidate process ownership and launch-contract regressions."""
import asyncio
from pathlib import Path
import sys
import tempfile
import unittest
import os
import urllib.request

from integrations.openjiuwen.package_runtime import script_command, absolute_script_command, start_candidate_service, service_environment


class PackageRuntimeTests(unittest.IsolatedAsyncioTestCase):
    def test_environment_rejects_reserved_names_and_non_strings(self):
        for values in ({'PORT':'9999'}, {'PYTHONPATH':'x'}, {'NODE_OPTIONS':'x'}, {'BUSINESS_URL':None}, {'BUSINESS_URL':'x\x00y'}):
            with self.assertRaises(ValueError):
                service_environment(values)

    async def test_service_configuration_is_scoped_to_each_process(self):
        original = os.environ.get('BUSINESS_SERVICE_URL')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'server.py').write_text('import os\nfrom http.server import HTTPServer,BaseHTTPRequestHandler\nclass Handler(BaseHTTPRequestHandler):\n def do_GET(self):\n  self.send_response(200);self.end_headers();self.wfile.write(os.environ["BUSINESS_SERVICE_URL"].encode())\nHTTPServer(("127.0.0.1",int(os.environ["PORT"])),Handler).serve_forever()')
            stops = []
            try:
                for value in ['https://first.example', 'https://second.example']:
                    endpoint, stop = await start_candidate_service(root, {'start':[sys.executable,'server.py'], 'environment':{'BUSINESS_SERVICE_URL':value}})
                    stops.append(stop)
                    def read():
                        with urllib.request.urlopen(endpoint) as response:
                            return response.read().decode()
                    self.assertEqual(await asyncio.to_thread(read), value)
                self.assertEqual(os.environ.get('BUSINESS_SERVICE_URL'), original)
            finally:
                for stop in reversed(stops):
                    await stop()

    async def test_service_error_does_not_retain_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'server.py').write_text('import os\nraise RuntimeError(os.environ["BUSINESS_SERVICE_URL"])')
            with self.assertRaises(RuntimeError) as raised:
                await start_candidate_service(root, {'start':[sys.executable,'server.py'], 'environment':{'BUSINESS_SERVICE_URL':'secret-address'}})
            self.assertNotIn('secret-address', str(raised.exception))

    def test_absolute_launch_resolves_entry_and_project_outside_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / 'scripts' / 'query.py'
            target.parent.mkdir()
            target.write_text('print(1)')
            command = absolute_script_command(root, target, {'kind':'PYTHON','launch':{'program':'uv','args':['run','--project','scripts','python','scripts/query.py']}})
            self.assertEqual(command[1:], ['run','--project',str(target.parent),'python',str(target)])

    def test_absolute_launch_preserves_business_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            target = root / 'query.mjs'
            target.write_text('console.log(1)')
            command = absolute_script_command(root,target,{'kind':'NODE','launch':{'program':'node','args':['query.mjs','--account','A1']}})
            self.assertEqual(command[1:], [str(target),'--account','A1'])
    def test_pep723_matches_technical_validation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "tool.py"
            target.write_text('# /// script\n# requires-python = ">=3.12"\n# dependencies = ["example"]\n# ///\n')
            command = script_command(root, target, {"kind": "PYTHON"})
            self.assertEqual(command[1:], ["run", "--no-project", "tool.py"])
            supplied = script_command(root, target, {"kind": "PYTHON", "launch": {"program": "uv", "args": ["run", "--no-project", "tool.py"]}})
            self.assertEqual(command, supplied)

    def test_locked_project_and_bound_entrypoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "pyproject.toml").write_text("[project]\n")
            (root / "uv.lock").write_text("")
            target = root / "tool.py"
            target.write_text("print('{}')")
            self.assertEqual(script_command(root, target, {"kind": "PYTHON"})[1:], ["run", "--project", ".", "--locked", "python", "-I", "tool.py"])
            with self.assertRaisesRegex(ValueError, "entrypoint"):
                script_command(root, target, {"kind": "PYTHON", "launch": {"program": "uv", "args": ["run", "other.py"]}})

    async def test_candidate_service_starts_and_releases_its_port(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "server.py").write_text('import os\nfrom http.server import HTTPServer,BaseHTTPRequestHandler\nHTTPServer(("127.0.0.1",int(os.environ["PORT"])),BaseHTTPRequestHandler).serve_forever()')
            endpoint, stop = await start_candidate_service(root, {"start": [sys.executable, "server.py"]})
            port = int(endpoint.split(":")[2].split("/")[0])
            await stop()
            with self.assertRaises(OSError):
                await asyncio.open_connection("127.0.0.1", port)

    async def test_failed_service_is_reaped(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "server.py").write_text('raise RuntimeError("broken candidate")')
            with self.assertRaisesRegex(RuntimeError, "Candidate MCP exited"):
                await start_candidate_service(root, {"start": [sys.executable, "server.py"]})


if __name__ == "__main__":
    unittest.main()
