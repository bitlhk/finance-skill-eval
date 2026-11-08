import base64
import unittest

from improvement.review_diff import execute


def encoded(value):
    return base64.b64encode(value.encode()).decode()


class ReviewDiffTest(unittest.TestCase):
    def test_late_change_is_visible_without_misrepresenting_full_file(self):
        prefix = 'unchanged line\n' * 1500
        result = execute({'changes': [{'path': 'tool.py', 'reason': 'MODIFIED',
                                      'before': encoded(prefix + 'old behavior\n'),
                                      'after': encoded(prefix + 'new behavior\n')}]})[0]
        self.assertIn('-old behavior', result['after'])
        self.assertIn('+new behavior', result['after'])
        self.assertIn('并非完整文件', result['after'])
        self.assertNotIn('before', result)

    def test_configuration_and_credential_contents_are_not_returned(self):
        data = encoded('API_KEY="sensitive-value"\n')
        rows = execute({'changes': [{'path': path, 'reason': 'MODIFIED', 'before': data, 'after': data}
                                    for path in ('.env.example', 'config.py')]})
        self.assertTrue(all('after' not in row and 'sensitive-value' not in str(row) for row in rows))

    def test_private_keys_and_authenticated_urls_are_hidden(self):
        for path, value in [('settings.py', 'URL="https://name:private-password@example.org"'),
                            ('public.txt', '-----BEGIN PRIVATE KEY-----\nprivate material'),
                            ('tls.key', 'private material')]:
            row = execute({'changes': [{'path': path, 'reason': 'MODIFIED', 'after': encoded(value)}]})[0]
            self.assertNotIn('after', row)
            self.assertNotIn('private', str(row))


if __name__ == '__main__':
    unittest.main()
