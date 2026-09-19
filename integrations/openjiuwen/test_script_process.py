import asyncio
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from integrations.openjiuwen.script_process import run_script


class ScriptProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_disabled(self):
        with patch.dict(os.environ, {'FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS': ''}):
            with self.assertRaisesRegex(RuntimeError, 'disabled'):
                await run_script([sys.executable, '-c', 'pass'], '.', b'')

    async def test_clean_environment(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS': '1', 'CANARY_SECRET': 'test'}):
            code, out, _ = await run_script([sys.executable, '-c', 'import os;print(os.getenv("CANARY_SECRET","absent"))'], Path(root), b'')
            self.assertEqual(code, 0)
            self.assertEqual(out.strip(), b'absent')

    async def test_output_limit(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS': '1'}):
            with self.assertRaisesRegex(RuntimeError, 'output exceeds'):
                await run_script([sys.executable, '-c', 'while True: print("x"*8192, flush=True)'], root, b'', limit=1024)

    @unittest.skipIf(os.name == 'nt', 'POSIX process group')
    async def test_descendant_timeout(self):
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {'FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS': '1'}):
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(run_script([sys.executable, '-c', 'import subprocess,sys,time;subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"]);time.sleep(60)'], root, b'', timeout=0.15), 3)
