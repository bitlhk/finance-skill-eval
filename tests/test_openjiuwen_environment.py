from importlib.metadata import PackageNotFoundError
import unittest
from unittest.mock import patch
from integrations.openjiuwen.environment_check import check_environment


class EnvironmentTests(unittest.TestCase):
    def test_project_interpreter_matches_manifest(self):
        report = check_environment()
        self.assertEqual(report['openjiuwen'], report['expectedOpenjiuwen'])

    def test_old_sdk_is_rejected_before_any_runtime_start(self):
        with patch('integrations.openjiuwen.environment_check.version', return_value='0.1.13.post1'):
            with self.assertRaisesRegex(RuntimeError, 'Wrong OpenJiuwen environment'):
                check_environment()

    def test_missing_sdk_has_an_actionable_error(self):
        with patch('integrations.openjiuwen.environment_check.version', side_effect=PackageNotFoundError):
            with self.assertRaisesRegex(RuntimeError, 'setup:openjiuwen'):
                check_environment()

    def test_unsupported_python_is_rejected_even_with_the_right_sdk(self):
        with patch('integrations.openjiuwen.environment_check.sys.version_info', (3, 14, 0)):
            with self.assertRaisesRegex(RuntimeError, 'expected Python'):
                check_environment()
