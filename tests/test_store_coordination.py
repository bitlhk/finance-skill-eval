import json
from pathlib import Path
import subprocess
import sys
import os
import tempfile
import unittest

from storage.coordination import execute as coordinate, CoordinationConflict
from storage.tasks import execute as tasks


class StoreCoordinationTests(unittest.TestCase):
    def test_process_death_releases_ownership_and_old_tokens_are_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            request = {'root': root, 'key': 'task-execution:bundle-ab'}
            script = ('import json,sys; from storage.coordination import execute; '
                      'print(execute({"root":sys.argv[1],"key":"task-execution:bundle-ab","action":"acquire"}),flush=True); '
                      'sys.stdin.read()')
            child = subprocess.Popen([sys.executable, '-B', '-c', script, root], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                old = child.stdout.readline().strip()
                self.assertTrue(old and old != 'None')
                self.assertIsNone(coordinate({**request, 'action': 'acquire'}))
                if os.name == 'nt':
                    subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], check=True, capture_output=True)
                else:
                    child.kill()
                child.wait(timeout=10)
                token = coordinate({**request, 'action': 'acquire'})
                self.assertTrue(token)
                try:
                    with self.assertRaises(CoordinationConflict):
                        coordinate({**request, 'action': 'verify', 'token': old})
                    self.assertTrue(coordinate({**request, 'action': 'verify', 'token': token}))
                finally:
                    coordinate({**request, 'action': 'release', 'token': token})
            finally:
                if child.poll() is None:
                    if os.name == 'nt':
                        subprocess.run(['taskkill', '/PID', str(child.pid), '/T', '/F'], capture_output=True)
                    else:
                        child.kill()
                child.communicate(timeout=10)

    def test_stale_task_save_cannot_overwrite_newer_result(self):
        with tempfile.TemporaryDirectory() as root:
            scope = {'root': root, 'key': 'task-write:bundle-ab'}
            token = coordinate({**scope, 'action': 'acquire'})
            request = {'root': root, 'id': 'bundle-ab', 'writeToken': token}
            original = {'id': 'bundle-ab', 'schemaVersion': 'finance.skill-migration.task.v3', 'createdAt': '2026'}
            try:
                first = tasks({**request, 'action': 'saveVersioned', 'value': original, 'expectedRevision': None})
                changed = {**original, 'goal': 'new goal'}
                tasks({**request, 'action': 'saveVersioned', 'value': changed, 'expectedRevision': first})
                with self.assertRaises(CoordinationConflict):
                    tasks({**request, 'action': 'saveVersioned', 'value': original, 'expectedRevision': first})
                self.assertEqual(tasks({**request, 'action': 'get'}), changed)
                coordinate({**scope, 'action': 'release', 'token': token})
                with self.assertRaises(CoordinationConflict):
                    tasks({**request, 'action': 'saveVersioned', 'value': original})
            finally:
                try:
                    coordinate({**scope, 'action': 'release', 'token': token})
                except CoordinationConflict:
                    pass
