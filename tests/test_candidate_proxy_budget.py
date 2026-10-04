import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('budget', Path(__file__).resolve().parents[1] / 'deploy/update-candidate-inspection-budget.py')
budget = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget)


class CandidateBudgetTest(unittest.TestCase):
    def test_only_timeout_changes(self):
        original = b'location ^~ /release-check/api/ {\n auth_request /private;\n proxy_read_timeout 600s;\n proxy_send_timeout 600s;\n}\n'
        self.assertEqual(budget.render(original), original.replace(b'proxy_read_timeout 600s;', b'proxy_read_timeout 950s;'))

    def test_other_routes_and_ambiguous_baselines_rejected(self):
        for text in [b'location / { proxy_read_timeout 600s; }',
                     b'location ^~ /release-check-other/ { proxy_read_timeout 600s; }',
                     b'location ^~ /release-check/api/ { proxy_read_timeout 600s; }\nlocation ~ /other { }',
                     b'location ^~ /api/ { proxy_read_timeout 600s; }',
                     b'location ^~ /release-check/api/ { proxy_read_timeout 950s; }',
                     b'location ^~ /release-check/api/ { proxy_read_timeout 600s; proxy_read_timeout 600s; }']:
            with self.assertRaises(ValueError): budget.render(text)

    def test_compare_before_replace_preserves_concurrent_edit(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'candidate.conf'
            path.write_bytes(b'parallel edit')
            with self.assertRaisesRegex(RuntimeError, 'CONFIGURATION_CHANGED'):
                budget.replace(path, b'old', b'new')
            self.assertEqual(path.read_bytes(), b'parallel edit')
            budget.replace(path, b'parallel edit', b'new')
            self.assertEqual(path.read_bytes(), b'new')


if __name__ == '__main__': unittest.main()
