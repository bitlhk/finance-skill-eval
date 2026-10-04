"""Audit saved Launcher results without making model or business requests."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re


def digest(data):
    return hashlib.sha256(data).hexdigest()


def canonical(data, unicode=False):
    return json.dumps(data, ensure_ascii=not unicode, sort_keys=True, separators=(',', ':')).encode()


def confined(root, *parts):
    candidate = root.joinpath(*parts)
    if any(part in {'', '.', '..'} or '/' in part or '\\' in part for part in parts):
        raise ValueError('UNSAFE_EVIDENCE_REFERENCE')
    if any(path.is_symlink() for path in [candidate, *candidate.parents] if path != root.parent):
        raise ValueError('SYMLINK_EVIDENCE_REFERENCE')
    candidate.resolve().relative_to(root.resolve())
    return candidate


def case_ids(job, manifest):
    configuration = job.get('configuration', {})
    selected = configuration.get('selectedCaseIds', [])
    def valid(values):
        return (isinstance(values, list) and bool(values)
                and all(isinstance(value, str) and value for value in values)
                and len(set(values)) == len(values))
    if manifest is not None:
        if not valid(manifest) or not set(selected).issubset(manifest):
            raise ValueError('INVALID_CASE_MANIFEST')
        return manifest, 'EXPLICIT_FROZEN_CASE_MANIFEST'
    if configuration.get('caseSource', 'fixed') != 'fixed' or configuration.get('includeHoldout') or not valid(selected):
        raise ValueError('CASE_MANIFEST_REQUIRED')
    return selected, 'REQUEST_SELECTED_CASE_IDS'


def audit(job, state, expected_case_ids=None):
    rows, archives = [], []
    evidence = job.get('evidence', [])
    ids, basis = case_ids(job, expected_case_ids)
    report_ids = [case['caseId'] for case in job['report']['cases']]
    expected = {(case, side) for case in ids for side in ('left', 'right')}
    actual = Counter((item['caseId'], item['side']) for item in evidence)
    checks = {'runCompleted': job['status'] == 'completed',
              'exactCaseCoverage': (bool(expected) and set(actual) == expected and all(n == 1 for n in actual.values())
                                    and len(report_ids) == len(ids) and set(report_ids) == set(ids))}
    for item in evidence:
        meta = item['metadata']
        ref = meta['retainedEvidenceRef']
        saved = json.loads(confined(state, ref['collection'], ref['ownerScope'], ref['buildId'], ref['runId'] + '.json').read_text())
        lock = saved['runtimeLock']
        receipt = json.loads(confined(state, 'deletion-receipts', meta['buildId'] + '.json').read_text())
        capabilities = [c for pack in lock['installations'] for c in pack['capabilities']]
        tools = {c['toolName'] for c in capabilities}
        row = {'caseId': item['caseId'], 'side': item['side'], 'requestId': meta['requestId'],
               'executionCompleted': item['status'] == 'completed' and item['runtimeIdentityVerified'] is True,
               'retainedDigest': digest(canonical(saved, unicode=True)) == ref['sha256'],
               'lockDigest': digest(canonical(lock)) == meta['runtimeLockSha256'],
               'runtimeMatchesLock': lock['runtime']['family'] == meta['runtime']['type'],
               'requestedArtifact': bool(meta.get('skillArtifactSha256')) and meta['skillArtifactSha256']
                   == job.get('configuration', {}).get(item['side'] + 'Variant', {}).get('artifactSha256'),
               'requestIdentity': all(saved[k] == meta[k] for k in ('requestId', 'sessionId', 'runId', 'buildId')),
               'methodInstalled': any(s['digest'] == meta['loadedSkillDigest'] for p in lock['domainInstallations'] for s in p['skills']),
               'onlyReadonlyInstalled': all(c['operation'] == 'QUERY' for c in capabilities),
               'callsMatchInstalledTools': all(c['name'] in tools for c in item['toolCalls']),
               'deletionReceipt': receipt['artifactLockSha256'] == meta['artifactLockSha256'],
               'buildRemoved': not confined(state, 'workbench', meta['buildId']).exists(),
               'jobRemoved': not confined(state, 'workbench-records', meta['buildId'] + '.json').exists()}
        rows.append(row)
        owner = confined(state, 'execution-history', ref['ownerScope'])
        history = confined(owner, meta['requestId'] + '.jsonl')
        events = [json.loads(line) for line in history.read_text().splitlines()]
        terminal = [e for e in events if e.get('recordType') == 'terminal']
        snapshots = [e for e in events if e.get('recordType') == 'model-snapshot']
        writes = {(e.get('callId'), e.get('part')): e for e in events if e.get('recordType') == 'model-snapshot-storage'}
        parts = Counter((e.get('callId'), e.get('part')) for e in snapshots)
        valid = bool(snapshots) and all(n == 1 for n in parts.values())
        for e in snapshots:
            call, part = e['callId'], e['part']
            if not re.fullmatch(r'[A-Za-z0-9-]{1,64}', call) or part not in {'request', 'response'}:
                raise ValueError('INVALID_SNAPSHOT_REFERENCE')
            body = confined(owner, 'model-snapshots', f"{meta['requestId']}.{call}.{part}.json")
            write = writes.get((call, part), {})
            valid = valid and body.is_file() and digest(body.read_bytes()) == e['digest']
            valid = valid and write.get('state') == 'WRITTEN' and write.get('digest') == e['digest']
        calls = {call for call, _ in parts}
        pairs = all(parts[(call, 'request')] == parts[(call, 'response')] == 1 for call in calls)
        archives.append({'requestId': meta['requestId'], 'snapshotParts': len(snapshots),
                         'snapshotDigestsAndWrites': valid, 'pairedClientSnapshots': pairs,
                         'terminalComplete': len(terminal) == 1 and terminal[0].get('complete') is True
                         and terminal[0].get('droppedEvents', 0) == 0})
    checks['executionVersionAndCleanup'] = bool(rows) and all(all(value is True for key, value in row.items()
        if key not in {'caseId', 'side', 'requestId'}) for row in rows)
    checks['archivesComplete'] = bool(archives) and all(all(row[key] for key in
        ('snapshotDigestsAndWrites', 'pairedClientSnapshots', 'terminalComplete')) for row in archives)
    checks['freshCaseSessions'] = len({e['metadata']['sessionId'] for e in evidence}) == len(evidence)
    checks['bothRuntimeFamilies'] = {e['metadata']['runtime']['type'] for e in evidence} == {'openjiuwen', 'agentscope'}
    for name, key in [('sameSkill', 'loadedSkillDigest'), ('sameModelConfiguration', 'modelConfigVersion'),
                      ('sameGeneration', 'declaredModelParameters'), ('sameBusinessDate', 'businessDate')]:
        checks[name] = bool(evidence) and len({json.dumps(e['metadata'][key], sort_keys=True) for e in evidence}) == 1
    return {'status': 'PASS' if all(checks.values()) else 'FAIL', 'checks': checks, 'rows': rows, 'archives': archives,
            'caseCoverageBasis': basis, 'expectedCaseIds': ids,
            'qualitySummary': job['report'].get('summary'), 'qualityIsSeparateFromExecutionAudit': True,
            'wireParametersIndependentlyVerified': False, 'genuineSsoVerified': False, 'publicCutover': False,
            'basis': 'RETAINED_LOCK_HISTORY_SNAPSHOTS_AND_DELETION_RECEIPTS_ZERO_NEW_HTTP'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', required=True, type=Path)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--case-manifest', type=Path,
                        help='Frozen expected case-ID JSON array, required for holdout/generated/implicit-all cases')
    args = parser.parse_args()
    raw = args.job.read_bytes()
    manifest_raw = args.case_manifest.read_bytes() if args.case_manifest else None
    result = audit(json.loads(raw), args.state, json.loads(manifest_raw) if manifest_raw is not None else None)
    if manifest_raw is not None:
        result['expectedCaseManifestSha256'] = digest(manifest_raw)
    result['sourceJobSha256'] = digest(raw)
    with args.out.open('x') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
    print(json.dumps({'status': result['status'], 'checks': result['checks']}, ensure_ascii=False))
    raise SystemExit(0 if result['status'] == 'PASS' else 1)
