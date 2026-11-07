import base64
import unittest

from assets.snapshot import SnapshotError, make_snapshot


def encoded(value):
    return base64.b64encode(value.encode('utf-8')).decode('ascii')


class MigrationSnapshotTest(unittest.TestCase):
    def test_unchanged_skill_keeps_its_historical_version(self):
        files = {'业务/SKILL.md': encoded('---\nname: 审核\ndescription: 审核数据\n---\n规则')}
        original = make_snapshot(files, 'source')
        revised = make_snapshot(files, 'r1', original)
        self.assertEqual(revised['digest'], original['digest'])
        self.assertEqual(revised['members'][0]['version'], 'source')
        self.assertEqual(revised['files'], files)

    def test_duplicate_yaml_identity_is_not_silently_accepted(self):
        files = {'SKILL.md': encoded('---\nname: first\nname: second\ndescription: 说明\n---\n规则')}
        with self.assertRaises(SnapshotError):
            make_snapshot(files, 'source')

    def test_candidate_cannot_drop_existing_skill(self):
        original = make_snapshot({'a/SKILL.md': encoded('---\nname: a\ndescription: A\n---\nA'),
                                  'b/SKILL.md': encoded('---\nname: b\ndescription: B\n---\nB')}, 'source')
        with self.assertRaises(SnapshotError) as failure:
            make_snapshot({'a/SKILL.md': original['files']['a/SKILL.md']}, 'r1', original)
        self.assertEqual(failure.exception.status, 409)


if __name__ == '__main__':
    unittest.main()
