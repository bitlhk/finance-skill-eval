"""Optional legacy OTLP ingress; Launcher-returned evidence remains primary.

Only correlated active executions are buffered. Receipt of spans never proves
trace completeness; an asynchronous exporter has no end-of-trace receipt.
"""
import asyncio
from copy import deepcopy
import json
import os
import secrets
import time
from api.contracts import parse


class ExternalTraceCollector:
    def __init__(self, wait_ms=5500):
        self.active, self.wait_ms = {}, wait_ms

    def begin(self, identity):
        self.active = {key: value for key, value in self.active.items() if time.monotonic() - value['created'] < 1200}
        if len(self.active) >= 128:
            raise ValueError('Too many active trace collections')
        trace_id, span_id = secrets.token_hex(16), secrets.token_hex(8)
        self.active[trace_id] = {'identity': deepcopy(identity), 'spanId': span_id, 'start': str(time.time_ns()),
            'created': time.monotonic(), 'resources': [], 'ids': set(), 'bytes': 0, 'truncated': False}
        return {'traceId': trace_id, 'traceparent': f'00-{trace_id}-{span_id}-01'}

    def ingest(self, payload):
        parsed = parse('telemetry', {'status': 'PARTIAL', 'source': 'otlp', 'scope': 'agent-process', 'otlp': payload})
        accepted = 0
        for resource in parsed['otlp']['resourceSpans']:
            for scope in resource['scopeSpans']:
                for span in scope['spans']:
                    session = self.active.get(span['traceId'].lower())
                    if not session or span['spanId'].lower() in session['ids']:
                        continue
                    batch = {**resource, 'scopeSpans': [{**scope, 'spans': [span]}]}
                    size = len(json.dumps(batch, ensure_ascii=False, separators=(',', ':')).encode())
                    if len(session['ids']) >= 240 or session['bytes'] + size > 100000:
                        session['truncated'] = True
                        continue
                    session['ids'].add(span['spanId'].lower())
                    session['bytes'] += size
                    session['resources'].append(batch)
                    accepted += 1
        return accepted

    async def finish(self, trace_id, wait=True):
        session = self.active[trace_id]
        try:
            if wait:
                await asyncio.sleep(self.wait_ms / 1000)
            attributes = [{'key': 'finance.' + key, 'value': {'stringValue': value}} for key, value in
                [('run.id', session['identity']['runId']), ('case.id', session['identity']['caseId']), ('side', session['identity']['side'])]]
            return {'status': 'PARTIAL' if session['ids'] else 'UNAVAILABLE', 'source': 'external-otlp', 'scope': 'received-agent-spans',
                'reason': 'Collection limit reached' if session['truncated'] else 'Export has no end-of-trace acknowledgement' if session['ids'] else 'No correlated spans received',
                'traceId': trace_id, 'receivedSpans': len(session['ids']), 'otlp': {'resourceSpans': [*session['resources'], {'scopeSpans': [
                    {'scope': {'name': 'finance.evaluation'}, 'spans': [{'traceId': trace_id, 'spanId': session['spanId'], 'name': 'execute_case',
                        'startTimeUnixNano': session['start'], 'endTimeUnixNano': str(time.time_ns()), 'attributes': attributes}]}]}]}}
        finally:
            self.active.pop(trace_id, None)


_collectors = {}


def collector_for(root):
    if os.getenv('FINANCE_EVAL_EXTERNAL_OTLP') != '1':
        return None
    from pathlib import Path
    return _collectors.setdefault(str(Path(root).resolve()), ExternalTraceCollector())


def decode_protobuf(payload):
    from google.protobuf.json_format import MessageToDict
    from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest
    import base64
    request = ExportTraceServiceRequest()
    request.ParseFromString(payload)
    value = MessageToDict(request)
    def identifiers(item):
        if isinstance(item, dict):
            for key, value in item.items():
                if key in ('traceId', 'spanId', 'parentSpanId') and isinstance(value, str):
                    item[key] = base64.b64decode(value, validate=True).hex()
                else:
                    identifiers(value)
        elif isinstance(item, list):
            for value in item:
                identifiers(value)
    identifiers(value)
    return value
