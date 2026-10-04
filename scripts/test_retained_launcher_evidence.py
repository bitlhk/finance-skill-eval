import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('audit', Path(__file__).with_name('verify-retained-launcher-evidence.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class EvidenceAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.job = {'status': 'completed', 'report': {'cases': [{'caseId': 'case'}]}, 'evidence': [],
                    'configuration': {side + 'Variant': {'artifactSha256': 'source'} for side in ('left', 'right')}}
        for side, family in [('left', 'openjiuwen'), ('right', 'agentscope')]:
            meta = {'requestId': side, 'sessionId': side, 'runId': side, 'buildId': side,
                    'loadedSkillDigest': 'skill', 'runtime': {'type': family},
                    'modelConfigVersion': 'model-v1', 'declaredModelParameters': {'temperature': 0},
                    'businessDate': '2026-09-20', 'artifactLockSha256': 'artifact', 'skillArtifactSha256': 'source'}
            lock = {'runtime': {'family': family}, 'installations': [],
                    'domainInstallations': [{'skills': [{'digest': 'skill'}]}]}
            saved = {**{key: meta[key] for key in ('requestId', 'sessionId', 'runId', 'buildId')}, 'runtimeLock': lock}
            meta['runtimeLockSha256'] = module.digest(module.canonical(lock))
            meta['retainedEvidenceRef'] = {'collection': 'retained', 'ownerScope': 'owner', 'buildId': side,
                                           'runId': side, 'sha256': module.digest(module.canonical(saved, unicode=True))}
            self.write(f'retained/owner/{side}/{side}.json', saved)
            self.write(f'deletion-receipts/{side}.json', {'artifactLockSha256': 'artifact'})
            events = []
            for part in ('request', 'response'):
                body = b'{}'
                path = self.root / f'execution-history/owner/model-snapshots/{side}.call.{part}.json'
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
                event = {'callId': 'call', 'part': part, 'digest': module.digest(body)}
                events.extend([{'recordType': 'model-snapshot', **event},
                               {'recordType': 'model-snapshot-storage', 'state': 'WRITTEN', **event}])
            events.append({'recordType': 'terminal', 'complete': True, 'droppedEvents': 0})
            (self.root / f'execution-history/owner/{side}.jsonl').write_text('\n'.join(map(json.dumps, events)))
            self.job['evidence'].append({'caseId': 'case', 'side': side, 'metadata': meta, 'toolCalls': [],
                                         'status': 'completed', 'runtimeIdentityVerified': True})

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data))

    def test_complete(self):
        self.assertEqual(module.audit(self.job, self.root)['status'], 'PASS')

    def test_missing_case_side(self):
        self.job['evidence'].pop()
        self.assertFalse(module.audit(self.job, self.root)['checks']['exactCaseCoverage'])

    def test_corrupt_body(self):
        (self.root / 'execution-history/owner/model-snapshots/left.call.request.json').write_text('changed')
        self.assertFalse(module.audit(self.job, self.root)['checks']['archivesComplete'])

    def test_shared_session(self):
        self.job['evidence'][1]['metadata']['sessionId'] = 'left'
        self.assertFalse(module.audit(self.job, self.root)['checks']['freshCaseSessions'])

    def test_retained_build(self):
        (self.root / 'workbench/left').mkdir(parents=True)
        self.assertFalse(module.audit(self.job, self.root)['checks']['executionVersionAndCleanup'])

    def test_lock_digest(self):
        self.job['evidence'][0]['metadata']['runtimeLockSha256'] = 'wrong'
        self.assertFalse(module.audit(self.job, self.root)['checks']['executionVersionAndCleanup'])

    def test_wrong_source_skill(self):
        self.job['configuration']['leftVariant']['artifactSha256'] = 'another-skill'
        self.assertFalse(module.audit(self.job, self.root)['checks']['executionVersionAndCleanup'])

    def test_unknown_tool(self):
        self.job['evidence'][0]['toolCalls'] = [{'name': 'not_installed'}]
        self.assertFalse(module.audit(self.job, self.root)['checks']['executionVersionAndCleanup'])

    def test_reference_escape(self):
        self.job['evidence'][0]['metadata']['retainedEvidenceRef']['collection'] = '../elsewhere'
        with self.assertRaisesRegex(ValueError, 'UNSAFE'):
            module.audit(self.job, self.root)

    def test_quality_failure_is_not_execution_failure(self):
        self.job['report']['summary'] = {'runtimeComparison': {'left': {'FAIL': 1}, 'right': {'FAIL': 1}}}
        report = module.audit(self.job, self.root)
        self.assertEqual(report['status'], 'PASS')
        self.assertEqual(report['qualitySummary'], self.job['report']['summary'])
        self.assertTrue(report['qualityIsSeparateFromExecutionAudit'])


if __name__ == '__main__':
    unittest.main()
