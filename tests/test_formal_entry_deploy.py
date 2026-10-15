import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json
import os

spec = importlib.util.spec_from_file_location('formal', Path(__file__).parents[1] / 'deploy/promote-formal-entry.py')
formal = importlib.util.module_from_spec(spec)
spec.loader.exec_module(formal)

ROOT = '''        location / {
            proxy_pass http://127.0.0.1:56371;
            proxy_http_version 1.1;
            proxy_set_header Host $http_host;
            proxy_set_header Connection "";
            proxy_buffering off;
            proxy_cache off;
            proxy_read_timeout 600s;
            proxy_send_timeout 600s;
        }'''
PREFIX = '''server {
 allow 116.204.37.89;
 deny all;
 include /synthetic/release-check-origin.conf;
 location ^~ /runtime/ { return 200; }
 location ^~ /migration/ { return 200; }
'''
ORIGIN = (PREFIX + ROOT + '\n}').encode()
TOKEN = 'SYNTHETIC_INGRESS_CREDENTIAL_1234567890'
GATEWAY = '''server {
 client_max_body_size 64k;
 location = /__auth_check { internal; return 401; }
 include /synthetic/candidate.conf;
 location ^~ /api/ {
  auth_request /__auth_check;
  auth_request_set $demo_user $upstream_http_x_studio_user;
  proxy_set_header X-Demo-User $demo_user;
  proxy_set_header Cookie "";
  proxy_pass $demo_upstream;
  proxy_read_timeout 600s;
 }
 location / {
  auth_request /__auth_check;
  auth_request_set $demo_user $upstream_http_x_studio_user;
  proxy_set_header X-Demo-User $demo_user;
  proxy_set_header Cookie "";
  proxy_pass $demo_upstream;
  proxy_read_timeout 600s;
 }
}'''.encode()


class FormalEntryTests(unittest.TestCase):
    def render(self, source=ORIGIN, web='/synthetic/root', token=TOKEN, port=56376):
        return formal.render_origin(source, web, token, port)

    def test_origin_preserves_legacy_candidate_and_network_boundary(self):
        result = self.render()
        self.assertTrue(result.startswith(PREFIX.encode()))
        self.assertIn(b'location ^~ /api/', result)
        self.assertIn(b'127.0.0.1:56376/api/', result)
        self.assertIn(b'client_max_body_size 8m;', result)
        self.assertIn(b'proxy_read_timeout 950s;', result)
        self.assertIn(b'root /synthetic/root;', result)
        self.assertIn(b'proxy_set_header X-Demo-User $http_x_demo_user;', result)
        self.assertIn(b'proxy_set_header Cookie "";', result)
        self.assertNotIn(b'56371', result)

    def test_refuses_newer_root_and_duplicate_root(self):
        for source in (ORIGIN.replace(b'56371', b'56370'), ORIGIN + ROOT.encode()):
            with self.subTest(source=source), self.assertRaises(ValueError):
                self.render(source)

    def test_refuses_existing_root_api(self):
        with self.assertRaisesRegex(ValueError, 'EXISTING_ROOT_API'):
            self.render(ORIGIN + b'location ^~ /api/ { return 403; }')

    def test_refuses_injection(self):
        for overrides in ({'web': '/tmp/a;'}, {'web': '/tmp/../secret'},
                          {'token': TOKEN+'";'}, {'port': '80;'}):
            with self.subTest(overrides=overrides), self.assertRaises(ValueError):
                self.render(**overrides)

    def test_requires_origin_network_boundary(self):
        with self.assertRaisesRegex(ValueError, 'BOUNDARY'):
            self.render(ORIGIN.replace(b'deny all;', b'allow all;'))

    def test_gateway_changes_only_two_budgets(self):
        expected = GATEWAY.replace(b'proxy_read_timeout 600s;', b'proxy_read_timeout 950s;')
        expected = expected.replace(b'location ^~ /api/ {', b'location ^~ /api/ {\n        client_max_body_size 8m;')
        self.assertEqual(formal.render_gateway(GATEWAY), expected)

    def test_gateway_refuses_untrusted_identity_or_missing_auth(self):
        for source in (GATEWAY.replace(b'$demo_user;', b'$http_x_demo_user;'),
                       GATEWAY.replace(b'auth_request /__auth_check;', b'')):
            with self.subTest(source=source), self.assertRaisesRegex(ValueError, 'AUTH_BOUNDARY'):
                formal.render_gateway(source)

    def test_gateway_does_not_overwrite_new_budgets(self):
        with self.assertRaisesRegex(ValueError, 'BUDGET_BASELINE'):
            formal.render_gateway(GATEWAY.replace(b'600s;', b'900s;'))

    def test_static_root_digest_and_missing_asset(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'assets').mkdir()
            (root/'assets/app.js').write_text('synthetic')
            (root/'index.html').write_text('<script src="/assets/app.js"></script>')
            self.assertEqual(len(formal.check_web(root)), 64)
            (root/'assets/app.js').unlink()
            with self.assertRaisesRegex(ValueError, 'ASSET_MISSING'):
                formal.check_web(root)

    def test_candidate_build_and_symlink_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root/'index.html').write_text('<script src="/release-check/assets/app.js"></script>')
            with self.assertRaisesRegex(ValueError, 'ROOT_BUILD_REQUIRED'):
                formal.check_web(root)
            (root/'external').symlink_to('/etc/hosts')
            with self.assertRaisesRegex(ValueError, 'SYMLINK'):
                formal.check_web(root)

    def test_cas_refuses_concurrent_edit(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp)/'config'
            path.write_bytes(b'newer edit')
            with self.assertRaisesRegex(RuntimeError, 'CONFIGURATION_CHANGED'):
                formal.config.replace(path, b'old', b'release')
            self.assertEqual(path.read_bytes(), b'newer edit')

    def test_apply_and_rollback_change_configuration_not_data(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root/'nginx.conf'
            target.write_bytes(GATEWAY)
            retained = root/'historical-record'
            retained.write_bytes(b'unchanged')
            receipt = root/'apply.json'
            with patch.object(formal, 'GATEWAY', target), patch.object(formal.config, 'run') as run:
                with patch('sys.argv', ['promote', '--target', 'gateway', '--apply',
                                      '--expected-sha256', formal.config.digest(GATEWAY),
                                      '--receipt', str(receipt)]):
                    formal.main()
                applied = json.loads(receipt.read_text())
                self.assertEqual(applied['status'], 'APPLIED')
                if os.name != 'nt':
                    self.assertEqual(Path(applied['backup']).stat().st_mode & 0o777, 0o600)
                self.assertEqual(target.read_bytes(), formal.render_gateway(GATEWAY))
                self.assertEqual(run.call_count, 3)
                with patch('sys.argv', ['promote', '--target', 'gateway', '--apply',
                                      '--rollback', str(receipt), '--expected-sha256', applied['afterSha256'],
                                      '--receipt', str(root/'rollback.json')]):
                    formal.main()
            self.assertEqual(target.read_bytes(), GATEWAY)
            self.assertEqual(retained.read_bytes(), b'unchanged')

    def test_failed_reload_restores_configuration(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            target = root/'nginx.conf'
            target.write_bytes(GATEWAY)
            with patch.object(formal, 'GATEWAY', target), patch.object(formal.config, 'run',
                    side_effect=[None, None, RuntimeError('RELOAD_FAILED'), None, None]), \
                    patch('sys.argv', ['promote', '--target', 'gateway', '--apply',
                                      '--expected-sha256', formal.config.digest(GATEWAY),
                                      '--receipt', str(root/'apply.json')]):
                with self.assertRaisesRegex(RuntimeError, 'RELOAD_FAILED'):
                    formal.main()
            self.assertEqual(target.read_bytes(), GATEWAY)
            self.assertFalse((root/'apply.json').exists())


if __name__ == '__main__':
    unittest.main()
