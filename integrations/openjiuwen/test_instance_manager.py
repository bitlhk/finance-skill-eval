import base64
import hashlib
import io
import unittest
import zipfile

from integrations.openjiuwen.instance_manager import InstanceManager


def archive(files):
    target = io.BytesIO()
    with zipfile.ZipFile(target, 'w') as bundle:
        for name, content in files.items():
            bundle.writestr(name, content)
    return base64.b64encode(target.getvalue()).decode()


def request(secret='token-value'):
    contents = {'SKILL.md': '# Demo', 'mcp/server.py': 'print("ok")'}
    digest_entries = [{'name': name, 'content': base64.b64encode(content.encode()).decode()}
                      for name, content in sorted(contents.items())]
    import json
    digest = hashlib.sha256(json.dumps(digest_entries, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    archive_base64 = archive(contents)
    archive_digest = hashlib.sha256(base64.b64decode(archive_base64)).hexdigest()
    return {
        'schemaVersion': 'finance.skill-eval.runtime-instance.v1',
        'runId': 'run', 'side': 'right', 'modelId': 'execution',
        'variant': {'mode': 'skill_version', 'skillId': 'demo', 'version': '1', 'artifactSha256': digest},
        'skill': {'skillId': 'demo', 'version': '1', 'artifactSha256': digest,
                  'instructions': '# Demo', 'files': {},
                  'archiveBase64': archive_base64, 'archiveSha256': archive_digest},
        'environment': {
            'environmentId': 'launcher',
            'candidateMcpServices': [{'assetDigest': digest, 'toolNames': ['lookup'],
                                      'filePaths': ['mcp/server.py'], 'start': ['python', 'mcp/server.py'],
                                      'environment': {}, 'secretBindings': {'API_TOKEN': 'mcp.0.API_TOKEN'}}],
            'runtimeToolConfig': {'context': {'user': {'type': 'string', 'value': {'$secret': 'context.user'}, 'sensitive': True}},
                                  'providers': {}, 'tools': {}},
        },
        'configuration': {}, 'secrets': {'mode': 'inline', 'values': {'mcp.0.API_TOKEN': secret, 'context.user': 'alice'}},
        'limits': {'timeoutMs': 300000},
    }


class InstanceManagerTests(unittest.TestCase):
    def test_nested_document_preserves_archive_paths(self):
        value = request()
        contents = {'skill/SKILL.md': '# Nested', 'skill/references/rules.md': 'Rules', 'mcp/server.py': 'pass'}
        encoded = archive(contents)
        value['skill'].update(skillFile='skill/SKILL.md', instructions='# Nested', files=contents,
                              archiveBase64=encoded, archiveSha256=hashlib.sha256(base64.b64decode(encoded)).hexdigest())
        hydrated = InstanceManager().create(value, 'nested')['_request']['skill']
        self.assertEqual(hydrated['files'], contents)
        self.assertNotIn('SKILL.md', hydrated['files'])
        value['skill']['files'] = {'SKILL.md': '# Nested'}
        with self.assertRaisesRegex(ValueError, 'files do not match'):
            InstanceManager().create(value, 'bad-alias')

    def test_rejects_entrypoint_or_instruction_mismatch(self):
        for change in ({'skillFile': '../SKILL.md'}, {'instructions': 'different'}):
            value = request()
            value['skill'].update(change)
            with self.assertRaisesRegex(ValueError, 'entrypoint'):
                InstanceManager().create(value, 'mismatch')

    def test_capacity_idempotency_and_expiry(self):
        manager = InstanceManager()
        first = manager.create(request(), 'first')
        manager.create(request(), 'second')
        self.assertEqual(manager.create(request(), 'first')['instanceId'], first['instanceId'])
        with self.assertRaisesRegex(RuntimeError, 'capacity'):
            manager.create(request(), 'third')
        first['_expires'] = 0
        manager.create(request(), 'third')
        self.assertIsNone(manager.get(first['instanceId']))
        self.assertNotIn('first', manager.idempotency)

    def test_hydrates_archive_and_secrets_only_for_execution(self):
        manager = InstanceManager()
        item = manager.create(request(), 'same-request')
        public = manager.public(item)
        self.assertNotIn('token-value', str(public))
        self.assertNotIn('_request', public)
        execution = manager.execution(item['instanceId'], {
            'schemaVersion': 'finance.skill-eval.runtime-case.v1', 'caseId': 'case', 'query': 'query', 'requiredTools': ['lookup'],
            'workspaceFiles': [{'path': 'fixtures/input.json', 'content': '{"account":"A1"}'}]})
        self.assertEqual(execution['skill']['files']['mcp/server.py'], 'print("ok")')
        self.assertEqual(execution['environment']['candidateMcpServices'][0]['environment']['API_TOKEN'], 'token-value')
        self.assertEqual(execution['environment']['runtimeToolConfig']['context']['user']['value'], 'alice')
        self.assertEqual(execution['environment']['instanceConfigurationDigest'], public['configurationDigest'])
        self.assertEqual(execution['case']['workspaceFiles'], [{'path': 'fixtures/input.json', 'content': '{"account":"A1"}'}])

    def test_idempotency_rejects_changed_secret_values(self):
        manager = InstanceManager()
        manager.create(request('first'), 'same-key')
        with self.assertRaisesRegex(RuntimeError, 'different configuration'):
            manager.create(request('second'), 'same-key')

    def test_hydrates_external_mcp_secrets_and_rejects_unsafe_archive(self):
        manager = InstanceManager()
        external = request()
        external['environment']['mcpServers'] = [{'endpoint': 'https://example.com/mcp', 'toolNames': ['lookup'],
                                                  'secretBindings': {'Authorization': 'external.0.authorization'}}]
        external['secrets']['values']['external.0.authorization'] = 'Bearer private'
        item = manager.create(external, 'external')
        self.assertNotIn('Bearer private', str(manager.public(item)))
        execution = manager.execution(item['instanceId'], {
            'schemaVersion': 'finance.skill-eval.runtime-case.v1', 'caseId': 'case', 'query': 'query'})
        self.assertEqual(execution['environment']['mcpServers'][0]['headers']['Authorization'], 'Bearer private')
        unsafe = request()
        unsafe_archive = archive({'../escape.py': 'bad'})
        unsafe['skill']['archiveBase64'] = unsafe_archive
        unsafe['skill']['archiveSha256'] = hashlib.sha256(base64.b64decode(unsafe_archive)).hexdigest()
        with self.assertRaisesRegex(ValueError, 'unsafe path'):
            manager.create(unsafe, 'unsafe')
        mismatch = request()
        mismatch['skill']['archiveSha256'] = 'a' * 64
        with self.assertRaisesRegex(ValueError, 'digest'):
            manager.create(mismatch, 'mismatch')

    def test_rejects_unsafe_duplicate_and_oversized_workspace_files(self):
        manager = InstanceManager()
        item = manager.create(request(), 'workspace')
        base = {'schemaVersion': 'finance.skill-eval.runtime-case.v1', 'caseId': 'case', 'query': 'query'}
        for files in (
            [{'path': '../escape.json', 'content': 'bad'}],
            [{'path': 'same.json', 'content': 'one'}, {'path': 'same.json', 'content': 'two'}],
            [{'path': 'large.json', 'content': 'x' * (256 * 1024 + 1)}],
        ):
            with self.assertRaisesRegex(ValueError, 'workspace'):
                manager.execution(item['instanceId'], {**base, 'workspaceFiles': files})


if __name__ == '__main__':
    unittest.main()
