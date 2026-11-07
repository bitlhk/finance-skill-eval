"""Project only allowed answer facts, never the whole execution trace."""
import json
import math
import re

from evaluation.checks import read_pointer


def resources(evidence):
    """Index the original execution evidence without inventing a second trace."""
    metadata = evidence.get('metadata') or {}
    execution = {'status': evidence['status'], 'elapsedMs': evidence.get('elapsedMs'),
                 'identityVerified': evidence.get('runtimeIdentityVerified'),
                 'streamCompleted': evidence.get('streamCompleted')}
    if 'caseState' in metadata:
        execution['caseState'] = metadata['caseState']
    if 'conversation' in metadata:
        # Existing Launcher turn receipts have already been correlated with
        # actual tool calls. Make them available to process judges/validators;
        # the answer-only projection still excludes execution facts.
        execution['conversation'] = metadata['conversation']
    return {'output': evidence.get('output', ''), 'toolCalls': evidence.get('toolCalls', []),
            'usage': evidence.get('usage'), 'execution': execution,
            **{key: metadata.get(key) for key in ('process', 'artifacts', 'state', 'telemetry', 'externalTelemetry')},
            'toolEvidence': metadata.get('toolEvidence', [])}


def string_length(value):
    return len(value.encode('utf-16-le', errors='surrogatepass')) // 2


def execute(request):
    resources = request['resources']
    plan = request.get('plan') or {}
    facts, provenance = {}, []
    for field in plan.get('answerEvidence', []):
        reference = field['reference']
        value = read_pointer(resources, reference)
        match = re.match(r'^/toolEvidence/(\d+)/result(/.+)$', reference)
        if match:
            receipt = read_pointer(resources, '/toolEvidence/' + match.group(1))
            if not isinstance(receipt, dict) or receipt.get('status') != 'completed' or receipt.get('resultOmitted') is True:
                value = None
            elif isinstance(receipt.get('result'), str) and string_length(receipt['result']) <= 64000:
                try:
                    value = read_pointer(json.loads(receipt['result']), match.group(2))
                except (ValueError, TypeError):
                    value = None
        available = ((isinstance(value, str) and string_length(value) <= 4000) or isinstance(value, bool)
                     or (isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)))
        facts[field['id']] = value if available else None
        provenance.append({'id': field['id'], 'reference': reference, 'available': available})
    return {'version': 'answer-materials-v1', 'materials': {'output': resources['output'], 'businessFacts': facts},
            'provenance': {'planVersion': plan.get('version'), 'fields': provenance}}
