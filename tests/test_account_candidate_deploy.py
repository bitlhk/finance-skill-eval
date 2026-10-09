import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('promote', Path(__file__).parents[1] / 'deploy/promote-account-candidate.py')
promote = importlib.util.module_from_spec(spec)
spec.loader.exec_module(promote)

FRAGMENT = '''location = /release-check { return 302 /release-check/; }
location ^~ /release-check/api/ {
 proxy_pass http://127.0.0.1:56373/api/;
 proxy_set_header Authorization "Bearer OLD_SYNTHETIC_CREDENTIAL_1234567890";
 proxy_set_header X-Demo-User $http_x_demo_user;
 proxy_set_header X-Migration-Authorization "";
 proxy_set_header Cookie "";
 proxy_read_timeout 950s;
}
location ^~ /release-check/ {
 alias /synthetic/old/web/;
}
'''.encode()
TOKEN = 'NEW_SYNTHETIC_CREDENTIAL_1234567890'


class AccountCandidateDeployTests(unittest.TestCase):
    def render(self, data=FRAGMENT, **kwargs):
        return promote.render(data, kwargs.get('port', 56376), kwargs.get('web', '/synthetic/new/web'), kwargs.get('token', TOKEN))

    def test_only_target_and_server_credential_change(self):
        expected = FRAGMENT.replace(b':56373/', b':56376/').replace(b'/synthetic/old/web/', b'/synthetic/new/web/').replace(b'OLD_SYNTHETIC_CREDENTIAL_1234567890', TOKEN.encode())
        self.assertEqual(self.render(), expected)

    def test_refuses_extra_route(self):
        with self.assertRaisesRegex(ValueError, 'FRAGMENT'):
            self.render(FRAGMENT + b'location / { return 200; }')

    def test_refuses_identity_boundary_change(self):
        with self.assertRaisesRegex(ValueError, 'INGRESS'):
            self.render(FRAGMENT.replace(b'$http_x_demo_user', b'studio_admin'))

    def test_refuses_ambiguous_target(self):
        with self.assertRaisesRegex(ValueError, 'AMBIGUOUS'):
            self.render(FRAGMENT.replace(b'proxy_pass ', b'proxy_pass http://127.0.0.1:1111/api/;\n proxy_pass '))

    def test_refuses_config_injection(self):
        for options in ({'token': TOKEN + '";'}, {'web': '/tmp/a;'}, {'web': '/tmp/../secret'}, {'port': '80;'}):
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.render(**options)

    def test_preflight_requires_account_mode(self):
        reply = unittest.mock.MagicMock()
        reply.__enter__.return_value.status = 200
        with patch.object(promote, 'urlopen', return_value=reply), patch.object(promote.json, 'load', return_value={'deploymentMode': 'single'}):
            with self.assertRaisesRegex(ValueError, 'ACCOUNT_MODE'):
                promote.preflight('http://127.0.0.1:1', TOKEN)

    def test_preflight_checks_both_trusted_factors_without_creating_accounts(self):
        from urllib.error import HTTPError
        reply = unittest.mock.MagicMock()
        reply.__enter__.return_value.status = 200
        responses = [reply, *[HTTPError('http://synthetic', code, '', {}, None) for code in (401, 401, 403)]]
        with patch.object(promote, 'urlopen', side_effect=responses) as calls, patch.object(promote.json, 'load', return_value={'deploymentMode': 'account-workspaces'}):
            promote.preflight('http://127.0.0.1:1', TOKEN)
        self.assertEqual(calls.call_count, 4)
        for call in calls.call_args_list:
            request = call.args[0]
            self.assertEqual(request.get_method(), 'GET')
            self.assertFalse(request.has_header('Authorization') and request.has_header('X-demo-user'))

    def test_preflight_refuses_anonymous_catalog(self):
        reply = unittest.mock.MagicMock()
        reply.__enter__.return_value.status = 200
        with patch.object(promote, 'urlopen', return_value=reply), patch.object(promote.json, 'load', return_value={'deploymentMode': 'account-workspaces'}):
            with self.assertRaisesRegex(ValueError, 'FAIL_CLOSED'):
                promote.preflight('http://127.0.0.1:1', TOKEN)


if __name__ == '__main__':
    unittest.main()
