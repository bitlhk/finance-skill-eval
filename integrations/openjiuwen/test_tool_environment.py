import unittest
from .package_runtime import declared_tool_environment


class ToolEnvironmentTest(unittest.TestCase):
    def test_only_declared_instance_values_are_mapped(self):
        public = {'tool.env.MEETINGROOM_BASE_URL': 'http://localhost:19000', 'unrelated': 'ignore'}
        secret = {'tool.env.MODEL_API_KEY': 'private', 'mcp.token': 'other'}
        self.assertEqual(declared_tool_environment(public, secret),
                         {'MEETINGROOM_BASE_URL': 'http://localhost:19000', 'MODEL_API_KEY': 'private'})
        self.assertEqual(secret['tool.env.MODEL_API_KEY'], 'private')
        self.assertEqual(declared_tool_environment({}, {}), {})

    def test_host_controls_and_duplicate_public_secret_values_are_rejected(self):
        for name in ['PATH', 'PYTHONPATH', 'FINANCE_RUNTIME_CONFIG', 'NODE_OPTIONS', 'LD_PRELOAD']:
            with self.assertRaises(ValueError):
                declared_tool_environment({'tool.env.' + name: 'bad'})
        with self.assertRaises(ValueError):
            declared_tool_environment({'tool.env.API_KEY': 'public'}, {'tool.env.API_KEY': 'private'})


if __name__ == '__main__':
    unittest.main()
