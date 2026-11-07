import base64
import io
import tempfile
import unittest
import zipfile

from assets.store import execute


def archive(files):
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as target:
        for name, value in files.items():
            target.writestr(name, value)
    return base64.b64encode(output.getvalue()).decode('ascii')


class AssetIdentityTests(unittest.TestCase):
    def test_unnamed_asset_keeps_identity_and_rejects_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            def upload(files, **options):
                return execute({'root': directory, 'action': 'upload', 'archive': archive(files),
                                'order': sorted(files), **options})
            original = upload({'skill.md': 'Original', 'scripts/tool.py': 'print(1)'})
            candidate = upload({'skill.md': 'Original', 'scripts/tool.py': 'print(2)'},
                               preserveIdentityFrom=original['assetId'], version='candidate')
            self.assertEqual(candidate['skillId'], original['skillId'])
            self.assertNotEqual(candidate['assetId'], original['assetId'])
            with self.assertRaisesRegex(ValueError, '身份'):
                upload({'skill.md': '---\nname: another\n---\nTask'}, preserveIdentityFrom=original['assetId'])
            with self.assertRaisesRegex(ValueError, '原 Skill 入口'):
                upload({'new/SKILL.md': 'Original'}, preserveIdentityFrom=original['assetId'])
