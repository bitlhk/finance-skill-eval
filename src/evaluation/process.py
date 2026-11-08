"""Validated process projection used by the native Launcher and evaluators."""
from copy import deepcopy
import json
from runtime.contracts import validate
from tasks.values import fingerprint


def with_process(evidence, required=False):
    evidence = deepcopy(evidence)
    metadata = evidence.setdefault('metadata', {})
    if 'process' not in metadata:
        if required:
            raise ValueError('Runtime execute response requires metadata.process (finance.runtime-process.v1)')
        return evidence
    process = validate('finance.runtime-process.v1', metadata['process'])
    if len(json.dumps(process, ensure_ascii=False, separators=(',', ':')).encode()) > 131072:
        raise ValueError('Process evidence exceeds 131072 bytes')
    records, scopes = process['records'], process['scopes']
    if len({r['id'] for r in records}) != len(records):
        raise ValueError('Process record IDs must be unique')
    seen = set()
    for record in records:
        if {'message': 'messages', 'model': 'models', 'tool': 'tools', 'event': 'events'}[record['kind']] not in scopes:
            raise ValueError('Record is outside declared process scopes')
        if record['kind'] in ('tool', 'model'):
            key = record['kind'], record.get('callId')
            if key in seen:
                raise ValueError('One terminal record per tool/model call is required')
            seen.add(key)
        if record.get('status') == 'incomplete' and process['status'] == 'COMPLETE':
            raise ValueError('Incomplete calls require partial process status')
    terminal = [r for r in records if r['kind'] == 'tool' and r['status'] != 'incomplete']
    calls = [{'name': r['name'], 'status': r['status']} for r in terminal]
    if process['status'] == 'COMPLETE' and 'tools' in scopes and evidence.get('toolCalls') and calls != evidence['toolCalls']:
        raise ValueError('Process tool records do not match toolCalls')
    evidence['toolCalls'] = evidence.get('toolCalls') or calls
    if 'toolEvidence' not in metadata:
        metadata['toolEvidence'] = [{
            'tool': r['name'], 'status': r['status'], 'callId': r['callId'],
            **({'arguments': r['input'], 'argumentsDigest': fingerprint(r['input'])} if 'input' in r else {}),
            **({'result': r['output'], 'resultDigest': fingerprint(r['output'])} if 'output' in r else {'resultOmitted': True}),
            **({'error': r['error']} if r.get('error') else {})} for r in terminal]
        if len(json.dumps(evidence, ensure_ascii=False, separators=(',', ':')).encode()) > 262144:
            metadata.pop('toolEvidence')
    return evidence
