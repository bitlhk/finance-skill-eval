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


def audit(job, state):
    rows, archives = [], []
    evidence = job.get('evidence', [])
    expected = {(case['caseId'], side) for case in job['report']['cases'] for side in ('left', 'right')}
    actual = Counter((item['caseId'], item['side']) for item in evidence)
    checks = {'runCompleted': job['status'] == 'completed',
              'exactCaseCoverage': bool(expected) and set(actual) == expected and all(n == 1 for n in actual.values())}
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
            'qualitySummary': job['report'].get('summary'), 'qualityIsSeparateFromExecutionAudit': True,
            'wireParametersIndependentlyVerified': False, 'genuineSsoVerified': False, 'publicCutover': False,
            'basis': 'RETAINED_LOCK_HISTORY_SNAPSHOTS_AND_DELETION_RECEIPTS_ZERO_NEW_HTTP'}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--job', required=True, type=Path)
    parser.add_argument('--state', required=True, type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    raw = args.job.read_bytes()
    result = audit(json.loads(raw), args.state)
    result['sourceJobSha256'] = digest(raw)
    with args.out.open('x') as output:
        json.dump(result, output, ensure_ascii=False, indent=2)
    print(json.dumps({'status': result['status'], 'checks': result['checks']}, ensure_ascii=False))
    raise SystemExit(0 if result['status'] == 'PASS' else 1)
