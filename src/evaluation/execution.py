"""Shared business execution boundary and validation of returned evidence."""
from copy import deepcopy
import json
from time import monotonic

from api.contracts import parse
from evaluation.checks import validate_artifacts
from evaluation.process import with_process
from evaluation.case_state import ExecutionFailure
from tasks.values import fingerprint


def validate_state(value, request, side):
    try:
        record = parse('case_state', value)
    except ValueError:
        return {'status': 'INCOMPLETE', 'reason': '缺少有效的业务状态回执'}
    def invalid(reason):
        return {'status': 'INCOMPLETE', 'reason': reason, 'reported': record}
    fixture = request['evalCase']['stateFixture']
    if record['status'] != 'COMPLETE' or record['errors'] or fingerprint(record['fixture']) != fingerprint(fixture):
        return invalid('状态操作未完整成功或测试初态不一致')
    for phase in ('prepare', 'capture', 'restore'):
        receipts = [receipt for receipt in record['receipts'] if receipt['phase'] == phase]
        if len(receipts) != 1:
            return invalid('业务状态回执与本次案例不匹配')
        receipt = receipts[0]
        if receipt['status'] != 'SUCCEEDED' or receipt['operationId'] != record['operationId'] or receipt['runId'] != request['runId'] or receipt['caseId'] != request['evalCase']['caseId'] or receipt['side'] != side or fingerprint(receipt['fixture']) != fingerprint(fixture):
            return invalid('业务状态回执与本次案例不匹配')
        if not receipt.get('stateDigest') or phase != 'capture' and receipt['stateDigest'] != fixture['initialStateDigest'] or phase == 'capture' and 'state' not in receipt or 'state' in receipt and fingerprint(receipt['state']) != receipt['stateDigest']:
            return invalid('业务初末状态或恢复摘要不一致')
    return record


def validate_telemetry(value, identity):
    try:
        telemetry = parse('telemetry', value)
    except ValueError:
        return {'status': 'UNAVAILABLE', 'source': 'runtime', 'scope': 'unknown', 'reason': 'Invalid OTLP evidence'}
    spans = [span for resource in telemetry['otlp']['resourceSpans'] for scope in resource['scopeSpans'] for span in scope['spans']]
    def invalid(status, reason):
        return {'status': status, 'source': telemetry['source'], 'scope': telemetry['scope'], 'reason': reason}
    if len(spans) > 256 or len(json.dumps(telemetry, ensure_ascii=False, separators=(',', ':')).encode('utf-16-le')) // 2 > 128000:
        return invalid('PARTIAL', 'Trace evidence exceeds collection limit')
    if not spans:
        return {**telemetry, 'status': 'UNAVAILABLE'}
    if any(int(span['endTimeUnixNano']) < int(span['startTimeUnixNano']) for span in spans) or len({span['traceId'] + ':' + span['spanId'] for span in spans}) != len(spans):
        return invalid('UNAVAILABLE', 'Invalid span identities or timestamps')
    attributes = [attribute for span in spans for attribute in span.get('attributes', [])]
    missing = False
    for key, expected in identity.items():
        recorded = [attribute for attribute in attributes if attribute['key'] == key]
        if any(attribute['value'].get('stringValue') != expected for attribute in recorded):
            return invalid('UNAVAILABLE', 'Trace belongs to another execution')
        missing |= not recorded
    return {**telemetry, 'status': 'PARTIAL', 'reason': 'Trace correlation attributes are missing'} if missing else telemetry


def validate_evidence(request, value):
    evidence = with_process(value)
    metadata = evidence.setdefault('metadata', {})
    side = 'right' if metadata.get('candidateAssessmentReused') is True and metadata.get('candidateAssessmentSourceSide') == 'right' else request['side']
    if request['evalCase'].get('stateFixture'):
        state = validate_state(metadata.get('caseState'), request, side)
        metadata['caseState'] = state
        metadata['state'] = next((item.get('state') for item in state.get('receipts', []) if item['phase'] == 'capture'), None) if state['status'] == 'COMPLETE' else None
    for field in ('telemetry', 'externalTelemetry'):
        if field in metadata:
            metadata[field] = validate_telemetry(metadata[field], {'finance.run.id': request['runId'], 'finance.case.id': request['evalCase']['caseId'], 'finance.side': side})
    if 'artifacts' in metadata:
        metadata['artifacts'] = validate_artifacts(metadata['artifacts'])['artifacts']
        metadata['artifactValidation'] = 'INVALID' if metadata['artifacts'] is None else 'VERIFIED_DIGESTS'
    return evidence


def failed_evidence(request, error, elapsed_ms):
    return {'runId': request['runId'], 'side': request['side'], 'caseId': request['evalCase']['caseId'], 'status': 'failed',
        'modelId': request['model']['modelId'], 'skillVersion': request['variant'].get('version'), 'output': '', 'elapsedMs': elapsed_ms,
        'toolCalls': [], 'loadedSkills': [], 'usage': None, 'runtimeIdentityVerified': False, 'streamCompleted': False,
        'error': str(error), 'metadata': deepcopy(getattr(error, 'metadata', {}))}


async def execute_case(runtime, request, *, failure_mode='evidence', on_event=None):
    started = monotonic()
    collector = getattr(runtime, 'trace_collector', None)
    collection = collector.begin({'runId': request['runId'], 'caseId': request['evalCase']['caseId'], 'side': request['side']}) if collector else None
    finished = False
    try:
        if request['evalCase'].get('stateFixture') and not runtime.state_supported:
            raise ExecutionFailure('Runtime 未提供业务初态与恢复能力，未执行此案例', {'executionDisposition': 'NOT_EXECUTED', 'caseState': {'status': 'UNAVAILABLE', 'reason': 'STATE_LIFECYCLE_UNAVAILABLE'}})
        business = deepcopy(request)
        business['evalCase'].pop('evaluationPlan', None)
        if collection:
            business['traceparent'] = collection['traceparent']
        result = await runtime.execute(business, on_event)
        if collection:
            result.setdefault('metadata', {})['externalTelemetry'] = await collector.finish(collection['traceId'])
            finished = True
        return validate_evidence(request, result)
    except Exception as error:
        if failure_mode == 'throw':
            raise
        return failed_evidence(request, error, round((monotonic() - started) * 1000))
    finally:
        if collection and not finished and collection['traceId'] in collector.active:
            await collector.finish(collection['traceId'], wait=False)
