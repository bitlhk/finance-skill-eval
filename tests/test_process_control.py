"""A supervisor pipe must not lock SDK DLL loading or lose graceful shutdown."""
import os
from pathlib import Path
import subprocess
import sys
from tempfile import TemporaryDirectory
import time
import unittest


class StopChannelTests(unittest.TestCase):
    def test_idle_stop_pipe_allows_numpy_import_and_then_stops(self):
        program = ('import time\nfrom runtime.process_control import start_stop_channel\n'
            'state={"stopped":False}\nstart_stop_channel(lambda:state.update(stopped=True))\n'
            'import numpy\nprint("ready",flush=True)\n'
            'while not state["stopped"]: time.sleep(.01)\nprint("stopped",flush=True)\n')
        with TemporaryDirectory() as directory:
            output = Path(directory) / 'output.txt'
            with output.open('wb') as stream:
                child = subprocess.Popen([sys.executable, '-B', '-c', program], stdin=subprocess.PIPE,
                    stdout=stream, stderr=stream, env={**os.environ, 'OPENBLAS_NUM_THREADS': '1'},
                    **({'creationflags': subprocess.CREATE_NO_WINDOW} if os.name == 'nt' else {}))
                try:
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline and b'ready' not in output.read_bytes() and child.poll() is None:
                        time.sleep(.05)
                    self.assertIn(b'ready', output.read_bytes(), 'SDK dependency import blocked on idle supervisor stdin')
                    child.stdin.write(b'stop\n')
                    child.stdin.flush()
                    self.assertEqual(child.wait(timeout=5), 0)
                    self.assertIn(b'stopped', output.read_bytes())
                finally:
                    if child.poll() is None:
                        child.kill()
                        child.wait()
                    child.stdin.close()
