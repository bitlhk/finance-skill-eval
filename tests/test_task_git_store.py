import base64
from pathlib import Path
import subprocess
import tempfile
import unittest

from assets.snapshot import files_digest
from storage.git import save, read, read_revision


def snapshot(raw):
    files = {name: base64.b64encode(value).decode('ascii') for name, value in raw.items()}
    return {'digest': files_digest(files), 'members': [], 'files': files}


class TaskGitStoreTests(unittest.TestCase):
    def test_round_trip_files_without_gitignore_or_text_conversion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = snapshot({'.gitignore': b'ignored.dat\n', 'ignored.dat': bytes([0, 255, 13, 10]),
                                 '中文/with "quote".txt': '原始\r\n'.encode()})
            first = save(root, 'bundle-a1', 'source', original)
            self.assertEqual(read(root, 'bundle-a1', first), original)
            revised = snapshot({'.gitignore': b'ignored.dat\n', 'ignored.dat': b'new',
                                '中文/with "quote".txt': '原始\r\n'.encode()})
            second = save(root, 'bundle-a1', 'candidate-a1', revised, parent='source')
            self.assertEqual(read(root, 'bundle-a1', second), revised)
            self.assertEqual(read_revision(root, 'bundle-a1', 'candidate-a1'), revised)
            self.assertEqual(read(root, 'bundle-a1', first), original)
            repo = root / 'migration-tasks' / 'git' / 'bundle-a1.git'
            parent = subprocess.check_output(['git', '--git-dir=' + str(repo), 'rev-parse', second['commit'] + '^']).decode().strip()
            self.assertEqual(parent, first['commit'])

    def test_prevents_overwrite_and_invalid_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            item = snapshot({'SKILL.md': b'test'})
            first = save(root, 'bundle-a1', 'source', item)
            self.assertEqual(save(root, 'bundle-a1', 'source', item), first)
            with self.assertRaisesRegex(ValueError, 'digest mismatch|different'):
                save(root, 'bundle-a1', 'source', snapshot({'SKILL.md': b'changed'}))
            with self.assertRaisesRegex(ValueError, 'different'):
                save(root, 'bundle-a1', 'source', {**item, 'members': [{'name': 'changed'}]})
            self.assertEqual(read(root, 'bundle-a1', first), item)
            with self.assertRaises(ValueError):
                save(root, 'bundle-../bad', 'source', item)
            with self.assertRaisesRegex(ValueError, 'digest'):
                save(root, 'bundle-b1', 'source', {**item, 'digest': 'wrong'})


if __name__ == '__main__':
    unittest.main()
