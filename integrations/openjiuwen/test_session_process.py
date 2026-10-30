import asyncio
import os
import sys
import unittest
from integrations.openjiuwen.session_process import terminate_tree


class SessionProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_descendant_is_reaped_and_inherited_pipe_closes(self):
        program = 'import subprocess,sys,time; subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"]); print("ready",flush=True); time.sleep(60)'
        process = await asyncio.create_subprocess_exec(sys.executable, '-c', program,
            stdout=asyncio.subprocess.PIPE, start_new_session=os.name != 'nt')
        try:
            self.assertEqual((await asyncio.wait_for(process.stdout.readline(), 10)).strip(), b'ready')
            await asyncio.wait_for(terminate_tree(process), 10)
            self.assertEqual(await asyncio.wait_for(process.stdout.read(), 5), b'')
            self.assertIsNotNone(process.returncode)
        finally:
            if process.returncode is None:
                await terminate_tree(process)


if __name__ == '__main__':
    unittest.main()
