import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest

spec = importlib.util.spec_from_file_location('capacity', Path(__file__).with_name('check-managed-release-capacity.py'))
capacity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capacity)


class CapacityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        checker = self.root / capacity.CHECKER
        checker.parent.mkdir(parents=True)
        checker.write_text('# controlled checker\n')
        self.sha = hashlib.sha256(checker.read_bytes()).hexdigest()
        self.env = self.root / 'config/example/environment.json'
        self.env.parent.mkdir(parents=True)
        self.env.write_text(json.dumps({'FH_SNAPSHOT_MAX_FILES': '512', 'FH_SNAPSHOT_MAX_BYTES': '67108864',
                                        'FH_HISTORY_REQUEST_BYTES': '1048576',
                                        'UNRELATED_SECRET': 'MUST_NOT_APPEAR'}))
        (self.root / 'state/example/execution-history').mkdir(parents=True)
        self.manifest = {'versions': {'builder': 'fixed'}, 'profiles': {'example': {
            'environmentSha256': hashlib.sha256(self.env.read_bytes()).hexdigest()}}}
        (self.root / 'release.json').write_text(json.dumps(self.manifest))
        self.calls = []

    def run_check(self, code=0, free=10 * 1024**3):
        def runner(command, **kwargs):
            self.calls.append(command)
            return SimpleNamespace(returncode=code, stdout=json.dumps({
                'scope': 'OWNER_EXECUTION_EVIDENCE', 'alert': code == 1,
                'snapshots': {'scope': 'OWNER_SNAPSHOT_BODIES', 'owners': [], 'alert': False},
                'archive': {'scope': 'OWNER_EXECUTION_ARCHIVE', 'owners': [], 'alert': code == 1}}))
        return capacity.inspect(self.root, self.sha, runner=runner,
                                disk_usage=lambda _: SimpleNamespace(free=free))

    def test_uses_pinned_limits_and_does_not_output_unrelated_config(self):
        report = self.run_check()
        self.assertFalse(report['alert'])
        self.assertIn('512', self.calls[0])
        self.assertIn('67108864', self.calls[0])
        self.assertNotIn('MUST_NOT_APPEAR', json.dumps(report))
        self.assertEqual(report['profiles'][0]['retentionSeconds'], 0)
        self.assertIn('--archive', self.calls[0])
        self.assertEqual(self.calls[0][self.calls[0].index('--archive-request-bytes') + 1], '1048576')
        self.assertEqual(self.calls[0][self.calls[0].index('--archive-manifest-bytes') + 1], '262144')
        self.assertEqual(self.calls[0][self.calls[0].index('--archive-total-bytes') + 1], '134217728')
        self.assertEqual(report['profiles'][0]['archiveOwners'], [])

    def test_archive_only_warning_is_not_healthy(self):
        report = self.run_check(code=1)
        self.assertTrue(report['profiles'][0]['alert'])
        self.assertFalse(report['profiles'][0]['snapshotAlert'])
        self.assertTrue(report['profiles'][0]['archiveAlert'])

    def test_old_snapshot_only_checker_cannot_silently_satisfy_archive_monitoring(self):
        def old_runner(*args, **kwargs):
            return SimpleNamespace(returncode=0, stdout=json.dumps({
                'scope': 'OWNER_SNAPSHOT_BODIES', 'owners': [], 'alert': False}))
        with self.assertRaisesRegex(ValueError, 'CHECKER_REPORT_INVALID'):
            capacity.inspect(self.root, self.sha, runner=old_runner)

    def test_warning_and_disk_pressure_are_not_healthy(self):
        self.assertTrue(self.run_check(code=1)['alert'])
        self.assertTrue(self.run_check(free=1024)['diskWarning'])

    def test_unavailable_checker_is_not_healthy(self):
        with self.assertRaisesRegex(ValueError, 'UNAVAILABLE'):
            self.run_check(code=2)

    def test_environment_drift_is_rejected(self):
        self.env.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'ENVIRONMENT_CHANGED'):
            self.run_check()
        self.assertEqual(self.calls, [])

    def test_checker_drift_is_rejected(self):
        (self.root / capacity.CHECKER).write_text('# changed')
        with self.assertRaisesRegex(ValueError, 'CHECKER_DIGEST'):
            self.run_check()

    def test_separate_pinned_monitor_does_not_need_runtime_replacement(self):
        alternate = 'config-amendments/monitor/check.py'
        target = self.root / alternate
        target.parent.mkdir(parents=True)
        target.write_bytes((self.root / capacity.CHECKER).read_bytes())
        calls = []
        def runner(command, **kwargs):
            calls.append(command)
            return SimpleNamespace(returncode=0, stdout=json.dumps({
                'scope': 'OWNER_EXECUTION_EVIDENCE', 'alert': False,
                'snapshots': {'scope': 'OWNER_SNAPSHOT_BODIES', 'owners': [], 'alert': False},
                'archive': {'scope': 'OWNER_EXECUTION_ARCHIVE', 'owners': [], 'alert': False}}))
        capacity.inspect(self.root, self.sha, runner=runner, checker_relative=alternate)
        self.assertEqual(calls[0][2], str(target))
        for unsafe in ['../outside.py', str(target)]:
            with self.assertRaisesRegex(ValueError, 'UNSAFE_RELEASE_PATH'):
                capacity.inspect(self.root, self.sha, runner=runner, checker_relative=unsafe)

    def test_symlink_history_is_rejected(self):
        history = self.root / 'state/example/execution-history'
        history.rmdir()
        history.symlink_to(self.root, target_is_directory=True)
        with self.assertRaisesRegex(ValueError, 'UNAVAILABLE'):
            self.run_check()


if __name__ == '__main__':
    unittest.main()
