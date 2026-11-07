import base64
from copy import deepcopy
import io
import json
import os
from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory
import unittest
import zipfile

from assets.store import execute


class NativeAssetOrderTests(unittest.TestCase):
    def setUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        execute({'root': str(self.root), 'action': 'initialize'})
        self.files = {'SKILL.md': b'---\nname: demo\ndescription: controlled\n---\nUse policy.', 'a.txt': b'a', 'B.txt': b'b'}
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            for name, data in self.files.items():
                archive.writestr(name, data)
        self.archive = base64.b64encode(output.getvalue()).decode()

    def upload(self, **options):
        return execute({'root': str(self.root), 'action': 'upload', 'archive': self.archive, **options})

    def test_native_upload_retains_order_metadata_and_reuses_identity(self):
        original = self.upload()
        self.assertEqual(self.upload(), original)
        result = execute({'root': str(self.root), 'action': 'readArchive', 'id': original['assetId']})
        self.assertEqual({name: base64.b64decode(value) for name, value in result.items()}, self.files)

    def test_imported_legacy_identity_is_unchanged_without_a_node_service(self):
        original = self.upload(order=['a.txt', 'B.txt', 'SKILL.md'])
        sidecar = self.root / 'skills/orders' / (original['assetId'] + '.json')
        sidecar.unlink()
        record = self.root / 'skills/records' / (original['assetId'] + '.json')
        before = record.read_bytes()
        project = Path(__file__).resolve().parents[1]
        result = subprocess.run(['node', str(project / 'scripts/export-legacy-asset-orders.mjs')], cwd=project,
            env={**os.environ, 'FINANCE_EVAL_DATA_DIR': str(self.root), 'FINANCE_EVAL_WORKSPACE_SEED_DIRECTORY': ''},
            text=True, capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['verified'], 1)
        self.assertEqual(record.read_bytes(), before)
        self.assertEqual(self.upload(), original)
        read = execute({'root': str(self.root), 'action': 'readArchive', 'id': original['assetId']})
        self.assertEqual({name: base64.b64decode(value) for name, value in read.items()}, self.files)

    def test_preserved_identity_is_checked_before_reusing_an_existing_asset(self):
        original = self.upload()
        record = self.root / 'skills/records' / (original['assetId'] + '.json')
        another = deepcopy(original)
        another.update(assetId='different-identity', skillId='different')
        (record.parent / 'different-identity.json').write_text(json.dumps(another))
        with self.assertRaisesRegex(ValueError, '不能改变 Skill 身份'):
            self.upload(preserveIdentityFrom='different-identity')
