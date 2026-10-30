import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('backup', Path(__file__).parents[1] / 'backup.py')
backup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backup)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.data, self.config = self.root / 'data', self.root / 'config'
        self.data.mkdir()
        self.config.mkdir()
        (self.data / '任务.json').write_text('{"status":"PASSED"}', encoding='utf-8')
        (self.config / 'production.env').write_text('PRIVATE=secret', encoding='utf-8')
        self.archive = self.root / 'backup.zip'

    def test_roundtrip_and_no_overwrite(self):
        backup.create(self.archive, self.data, self.config)
        destination = self.root / 'restore'
        backup.restore(self.archive, destination)
        self.assertEqual((destination / 'data/任务.json').read_bytes(), (self.data / '任务.json').read_bytes())
        self.assertEqual((destination / 'config/production.env').read_text(), 'PRIVATE=secret')
        with self.assertRaises(ValueError):
            backup.restore(self.archive, destination)
        with self.assertRaises(FileExistsError):
            backup.create(self.archive, self.data, self.config)

    def test_rejects_live_state_and_archive_in_source(self):
        with self.assertRaises(ValueError):
            backup.create(self.data / 'backup.zip', self.data, self.config)
        (self.data / 'processes').mkdir()
        (self.data / 'processes/api.json').write_text('{}')
        with self.assertRaises(ValueError):
            backup.create(self.archive, self.data, self.config)

    def test_rejects_traversal_and_digest_mismatch_before_restore(self):
        for name, digest in [('../escape', 'bad'), ('data/file', 'bad')]:
            archive = self.root / ('bad-' + str(len(name)) + '.zip')
            with zipfile.ZipFile(archive, 'w') as output:
                output.writestr(name, 'payload')
                output.writestr('manifest.json', json.dumps({'files': {name: digest}}))
            with self.assertRaises(ValueError):
                backup.restore(archive, self.root / 'restore')
            self.assertFalse((self.root / 'restore').exists())


if __name__ == '__main__':
    unittest.main()
