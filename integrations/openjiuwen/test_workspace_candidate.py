import base64
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from assets.snapshot import files_digest
from .workspace_candidate import prepare_candidate


def digest(files):
    return files_digest({name: base64.b64encode(value).decode('ascii') for name, value in files.items()})


class WorkspaceCandidateTests(unittest.TestCase):
    def test_new_attempt_uses_selected_files_and_preserves_unfinished_work_in_git(self):
        with tempfile.TemporaryDirectory() as root:
            workspace = Path(root) / 'workspace'
            workspace.mkdir()
            candidate = workspace / 'candidate'
            candidate.mkdir()
            original = {'tool.py': b'original'}
            (candidate / 'tool.py').write_bytes(original['tool.py'])
            prepare_candidate(workspace, Path(root), 'bundle-a1', 'attempt-a1', digest(original), original)
            (candidate / 'tool.py').write_bytes(b'unfinished edit')
            (candidate / 'empty-dir').mkdir()
            # Answering the same question retains the in-progress edit.
            prepare_candidate(workspace, Path(root), 'bundle-a1', 'attempt-a1', digest(original), original, answering=True)
            self.assertEqual((candidate / 'tool.py').read_bytes(), b'unfinished edit')
            selected = {'other.py': b'selected version'}
            prepare_candidate(workspace, Path(root), 'bundle-a1', 'attempt-a2', digest(selected), selected)
            self.assertFalse((candidate / 'tool.py').exists())
            self.assertEqual((candidate / 'other.py').read_bytes(), b'selected version')
            repo = Path(root) / 'migration-tasks' / 'git' / 'bundle-a1.git'
            commits = subprocess.check_output(['git', '--git-dir=' + str(repo), 'for-each-ref',
                '--format=%(objectname)', 'refs/finance/snapshots']).decode().splitlines()
            self.assertEqual(len(commits), 1)
            listing = subprocess.check_output(['git', '--git-dir=' + str(repo), 'ls-tree', '-r', '--name-only', commits[0]]).decode().splitlines()
            marker = next(name for name in listing if name.startswith('.finance-task-preservation-'))
            metadata = json.loads(subprocess.check_output(['git', '--git-dir=' + str(repo), 'show', commits[0] + ':' + marker]))
            self.assertEqual(metadata['emptyDirectories'], ['empty-dir'])
            self.assertEqual(subprocess.check_output(['git', '--git-dir=' + str(repo), 'show', commits[0] + ':tool.py']), b'unfinished edit')

    def test_recovers_after_interruption_between_directory_moves(self):
        with tempfile.TemporaryDirectory() as root:
            workspace = Path(root) / 'workspace'
            workspace.mkdir()
            candidate = workspace / 'candidate'
            candidate.mkdir()
            original = {'tool.py': b'old'}
            (candidate / 'tool.py').write_bytes(b'old')
            prepare_candidate(workspace, Path(root), 'bundle-a1', 'attempt-a1', digest(original), original)
            updated = {'tool.py': b'new'}
            replace = os.replace
            def interrupted(source, target):
                replace(source, target)
                if Path(source).name == 'candidate':
                    raise OSError('simulated interruption')
            with patch('integrations.openjiuwen.workspace_candidate.os.replace', side_effect=interrupted):
                with self.assertRaisesRegex(OSError, 'simulated'):
                    prepare_candidate(workspace, Path(root), 'bundle-a1', 'attempt-a2', digest(updated), updated)
            prepare_candidate(workspace, Path(root), 'bundle-a1', 'attempt-a2', digest(updated), updated)
            self.assertEqual((candidate / 'tool.py').read_bytes(), b'new')
            self.assertEqual(json.loads((workspace / '.candidate-binding.json').read_text())['attemptId'], 'attempt-a2')
            self.assertFalse((workspace / '.candidate-transition.json').exists())

    def test_preserves_original_directory_if_git_verification_fails(self):
        with tempfile.TemporaryDirectory() as root:
            workspace = Path(root) / 'workspace'
            workspace.mkdir()
            candidate = workspace / 'candidate'
            candidate.mkdir()
            original = {'tool.py': b'old'}
            (candidate / 'tool.py').write_bytes(b'old')
            prepare_candidate(workspace, Path(root), 'bundle-a1', 'attempt-a1', digest(original), original)
            updated = {'tool.py': b'new'}
            from .workspace_candidate import read_git_snapshot
            calls = 0
            def fail_second(*args):
                nonlocal calls
                calls += 1
                if calls == 2:
                    raise OSError('simulated Git read failure')
                return read_git_snapshot(*args)
            with patch('integrations.openjiuwen.workspace_candidate.read_git_snapshot', side_effect=fail_second):
                with self.assertRaisesRegex(OSError, 'Git read failure'):
                    prepare_candidate(workspace, Path(root), 'bundle-a1', 'attempt-a2', digest(updated), updated)
            old = next(workspace.glob('candidate-old-*'))
            self.assertEqual((old / 'tool.py').read_bytes(), b'old')
            prepare_candidate(workspace, Path(root), 'bundle-a1', 'attempt-a2', digest(updated), updated)
            self.assertEqual((candidate / 'tool.py').read_bytes(), b'new')


if __name__ == '__main__':
    unittest.main()
