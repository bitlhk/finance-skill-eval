import tempfile
import unittest
from pathlib import Path

from filelock import Timeout

from .agent_session import task_session_identity
from .agent_workspace import TaskWorkspace


class TaskWorkspaceTests(unittest.TestCase):
    def test_resume_preserves_edits_and_validates_original_source(self):
        with tempfile.TemporaryDirectory() as root:
            session_id = task_session_identity('workspace', 'task')
            with TaskWorkspace(root, session_id) as first:
                workspace = first.initialize({'source/original.txt': b'original',
                                              'candidate/tool.py': b'old'}, 'a' * 64)
                (workspace / 'candidate/tool.py').write_text('changed', encoding='utf-8')
                with self.assertRaises(Timeout):
                    with TaskWorkspace(root, session_id):
                        pass
            with TaskWorkspace(root, session_id) as restored:
                workspace = restored.initialize({'candidate/tool.py': b'ignored'}, 'a' * 64)
                self.assertEqual((workspace / 'candidate/tool.py').read_text(encoding='utf-8'), 'changed')
                self.assertEqual((workspace / 'source/original.txt').read_bytes(), b'original')
                with self.assertRaisesRegex(ValueError, 'original source'):
                    restored.initialize({}, 'b' * 64)
            with TaskWorkspace(root, task_session_identity('workspace', 'other')) as other:
                self.assertNotEqual(other.initialize({}, 'a' * 64), workspace)

    def test_rejects_unsafe_or_reserved_paths_and_requires_lock(self):
        with tempfile.TemporaryDirectory() as root:
            workspace = TaskWorkspace(root, task_session_identity('workspace', 'task'))
            with self.assertRaisesRegex(RuntimeError, 'locked'):
                workspace.initialize({}, 'a' * 64)
            with workspace:
                for name in ('../outside.txt', 'folder/../../outside.txt', 'folder/../.task-workspace.json'):
                    with self.subTest(name=name), self.assertRaises(ValueError):
                        workspace.initialize({name: b'data'}, 'a' * 64)
                self.assertFalse((Path(root) / 'outside.txt').exists())
