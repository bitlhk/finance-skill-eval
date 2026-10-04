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
        self.job['configuration'].update(selectedCaseIds=['case'], caseSource='fixed', includeHoldout=False)
        for side, family in [('left', 'openjiuwen'), ('right', 'agentscope')]:
            meta = {'requestId': side, 'sessionId': side, 'runId': side, 'buildId': side,
                    'loadedSkillDigest': 'skill', 'runtime': {'type': family},
                    'modelConfigVersion': 'model-v1', 'declaredModelParameters': {'temperature': 0},
                    'businessDate': '2026-09-20', 'businessTimeZone': 'Asia/Shanghai',
                    'artifactLockSha256': 'artifact', 'skillArtifactSha256': 'source'}
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

    def workspace(self, side='left'):
        item = next(e for e in self.job['evidence'] if e['side'] == side)
        meta = item['metadata']
        saved = json.loads((self.root / f'retained/owner/{side}/{side}.json').read_text())
        workspace = {'schemaVersion': 'finance.case-workspace.v1', 'digest': 'a' * 64,
                     'paths': ['case.txt'], 'storage': 'IMMUTABLE_CASE_DATA', 'toolName': 'read_case_file'}
        saved['runtimeLock']['caseWorkspace'] = workspace
        meta.update(workspaceFilesDigest=workspace['digest'], caseWorkspace={
            'schemaVersion': workspace['schemaVersion'], 'digest': workspace['digest'], 'closed': True,
            'reads': [{'path': 'case.txt', 'sha256': 'b' * 64, 'bytes': 10}]})
        saved['metadata'] = {'caseWorkspace': json.loads(json.dumps(meta['caseWorkspace']))}
        meta['runtimeLockSha256'] = module.digest(module.canonical(saved['runtimeLock']))
        meta['retainedEvidenceRef']['sha256'] = module.digest(module.canonical(saved, unicode=True))
        self.write(f'retained/owner/{side}/{side}.json', saved)
        item['toolCalls'] = [{'name': 'read_case_file', 'status': 'completed'}]
        return meta

    def test_complete(self):
        self.assertEqual(module.audit(self.job, self.root)['status'], 'PASS')

    def test_missing_case_side(self):
        self.job['evidence'].pop()
        self.assertFalse(module.audit(self.job, self.root)['checks']['exactCaseCoverage'])

    def test_whole_requested_case_missing_from_report_and_evidence(self):
        self.job['configuration']['selectedCaseIds'].append('missing-case')
        self.assertFalse(module.audit(self.job, self.root)['checks']['exactCaseCoverage'])

    def test_duplicate_report_case_rejected(self):
        self.job['report']['cases'].append({'caseId': 'case'})
        self.assertFalse(module.audit(self.job, self.root)['checks']['exactCaseCoverage'])

    def test_holdout_needs_frozen_manifest(self):
        self.job['configuration']['includeHoldout'] = True
        with self.assertRaisesRegex(ValueError, 'CASE_MANIFEST_REQUIRED'):
            module.audit(self.job, self.root)

    def test_implicit_all_cases_needs_frozen_manifest(self):
        self.job['configuration']['selectedCaseIds'] = []
        with self.assertRaisesRegex(ValueError, 'CASE_MANIFEST_REQUIRED'):
            module.audit(self.job, self.root)

    def test_manifest_does_not_make_omitted_holdout_pass(self):
        self.job['configuration']['includeHoldout'] = True
        result = module.audit(self.job, self.root, ['case', 'holdout-case'])
        self.assertFalse(result['checks']['exactCaseCoverage'])
        self.assertEqual(result['caseCoverageBasis'], 'EXPLICIT_FROZEN_CASE_MANIFEST')

    def test_manifest_cannot_drop_requested_cases(self):
        with self.assertRaisesRegex(ValueError, 'INVALID_CASE_MANIFEST'):
            module.audit(self.job, self.root, ['another-case'])

    def test_manifest_rejects_duplicates(self):
        with self.assertRaisesRegex(ValueError, 'INVALID_CASE_MANIFEST'):
            module.audit(self.job, self.root, ['case', 'case'])

    def test_explicit_manifest_for_unselected_cases(self):
        self.job['configuration']['selectedCaseIds'] = []
        result = module.audit(self.job, self.root, ['case'])
        self.assertEqual(result['status'], 'PASS')

    def test_corrupt_body(self):
        (self.root / 'execution-history/owner/model-snapshots/left.call.request.json').write_text('changed')
        self.assertFalse(module.audit(self.job, self.root)['checks']['archivesComplete'])

    def test_shared_session(self):
        self.job['evidence'][1]['metadata']['sessionId'] = 'left'
        self.assertFalse(module.audit(self.job, self.root)['checks']['freshCaseSessions'])

    def test_same_date_with_different_or_unknown_timezone_is_not_equivalent(self):
        for timezone in ('UTC', None):
            with self.subTest(timezone=timezone):
                self.job['evidence'][1]['metadata']['businessTimeZone'] = timezone
                self.assertFalse(module.audit(self.job, self.root)['checks']['sameBusinessTimeZone'])

    def test_case_file_inputs_must_match_between_runtime_sides(self):
        self.job['evidence'][1]['metadata']['workspaceFilesDigest'] = 'f' * 64
        self.assertFalse(module.audit(self.job, self.root)['checks']['sameCaseWorkspaceInputs'])

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

    def test_workspace_tool_requires_its_own_lock_and_closed_receipts(self):
        self.workspace()
        self.workspace('right')
        self.assertEqual(module.audit(self.job, self.root)['status'], 'PASS')

    def test_workspace_name_alone_is_not_an_allowlist(self):
        self.job['evidence'][0]['toolCalls'] = [{'name': 'read_case_file'}]
        self.assertFalse(module.audit(self.job, self.root)['checks']['executionVersionAndCleanup'])

    def test_workspace_receipt_mismatch_rejected(self):
        meta = self.workspace()
        meta['caseWorkspace']['reads'][0]['path'] = 'another.txt'
        self.assertFalse(module.audit(self.job, self.root)['checks']['executionVersionAndCleanup'])

    def test_unclosed_workspace_rejected(self):
        meta = self.workspace()
        meta['caseWorkspace']['closed'] = False
        self.assertFalse(module.audit(self.job, self.root)['checks']['executionVersionAndCleanup'])

    def test_wrong_workspace_digest_rejected(self):
        meta = self.workspace()
        meta['workspaceFilesDigest'] = 'c' * 64
        self.assertFalse(module.audit(self.job, self.root)['checks']['executionVersionAndCleanup'])

    def test_workspace_digest_without_lock_rejected(self):
        self.job['evidence'][0]['metadata']['workspaceFilesDigest'] = 'a' * 64
        self.assertFalse(module.audit(self.job, self.root)['checks']['executionVersionAndCleanup'])

    def test_workspace_paths_match_the_safe_relative_path_contract(self):
        meta = self.workspace()
        for path in ('/absolute', '../escape', 'x//y', 'x/./y', 'x\\y', 'C:relative', 'x\0y'):
            with self.subTest(path=repr(path)):
                receipt = {**meta['caseWorkspace'], 'reads': []}
                lock = {'caseWorkspace': {'schemaVersion': receipt['schemaVersion'],
                        'digest': receipt['digest'], 'paths': [path],
                        'storage': 'IMMUTABLE_CASE_DATA', 'toolName': 'read_case_file'}}
                tools, valid = module.workspace_tools(lock, {**meta, 'caseWorkspace': receipt},
                                                      {'metadata': {'caseWorkspace': receipt}}, [])
                self.assertFalse(valid)
                self.assertEqual(tools, set())

    def test_workspace_read_count_and_byte_type_are_checked(self):
        meta = self.workspace()
        saved = json.loads((self.root / 'retained/owner/left/left.json').read_text())
        self.assertFalse(module.workspace_tools(saved['runtimeLock'], meta, saved, [
            {'name': 'read_case_file'}, {'name': 'read_case_file'}])[1])
        meta['caseWorkspace']['reads'][0]['bytes'] = True
        saved['metadata']['caseWorkspace'] = meta['caseWorkspace']
        self.assertFalse(module.workspace_tools(saved['runtimeLock'], meta, saved,
                                                [{'name': 'read_case_file'}])[1])

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
