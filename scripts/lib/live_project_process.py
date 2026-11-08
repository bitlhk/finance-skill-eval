"""Map observed AgentScope example events without inventing missing evidence."""
import math


def process_evidence(events, context):
    records = [{'id': 'runtime-context', 'kind': 'event', 'name': 'runtime_context', 'data': context}]
    calls = set()
    for index, event in enumerate(events):
        name, call_id, status = event.get('name'), event.get('call_id'), event.get('status')
        duration = event.get('duration_ms')
        common = {'id': f'event-{index}'}
        if isinstance(name, str) and 0 < len(name) <= 200:
            common['name'] = name
        if isinstance(duration, (int, float)) and not isinstance(duration, bool) and math.isfinite(duration) and duration >= 0:
            common['durationMs'] = duration
        if (common.get('name') and isinstance(call_id, str) and 0 < len(call_id) <= 200
                and status in ('completed', 'failed', 'incomplete') and call_id not in calls):
            calls.add(call_id)
            record = {**common, 'kind': 'tool', 'callId': call_id, 'status': status}
            for source, target in (('input', 'input'), ('content', 'output'), ('error', 'error')):
                if source in event and event[source] is not None:
                    record[target] = str(event[source])[:4000] if source == 'error' else event[source]
        else:
            record = {**common, 'kind': 'event', 'data': dict(event)}
        records.append(record)
    scopes = ['events'] + (['tools'] if calls else [])
    return {'schemaVersion': 'finance.runtime-process.v1', 'status': 'PARTIAL', 'scopes': scopes,
            'reason': 'Only returned events are collected; framework built-in and model activity may be absent',
            'records': records}
