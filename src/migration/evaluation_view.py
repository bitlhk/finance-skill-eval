"""Frozen evaluation views for optimization and independent review."""
from evaluation.packs import suite_cases
from tasks.values import fingerprint
from .facts import completed_repetitions, suite_digest
from .state import MigrationControlError
import base64
import re


def optimization_evaluation(task, run):
    if run['phase'] != 'development':
        raise MigrationControlError('留出验收不能进入优化')
    group = completed_repetitions(task, run, 'effect')
    cases = []
    for case in suite_cases(run['suite']):
        result = next((item for item in run['cases'] if item['id'] == case['caseId']), None)
        repeated = [next((item for item in other['cases'] if item['id'] == case['caseId']), None) for other in group] if group else None
        passed = all(item['passed'] for item in repeated) if repeated and all(item and not item.get('failureStage') and not item.get('unverified') for item in repeated) else None
        cases.append({'id': case['caseId'], 'passed': passed, 'observation': {'task': case['prompt'], 'criteria': case['rubric'],
            'result': result, **({'repetitions': repeated} if run.get('repetition') else {})}})
    return {'id': run['id'], 'candidate': {'id': run['candidateId'], 'digest': run['candidateDigest']},
        'basicValidation': {'runStatus': run['status'], 'requirements': run.get('assessmentRequirements', []), 'coverage': run.get('requirementCoverage', []),
            **({'repetitions': [{'runId': other['id'], 'status': other['status'], 'coverage': other.get('requirementCoverage', [])} for other in group] if group else None} if run.get('repetition') else {})},
        'criteriaDigest': fingerprint({'suite': suite_digest(run['suite']), 'judge': run.get('judgeDigest'), 'plan': task.get('analysis')}),
        'protocolDigest': fingerprint({'suite': suite_digest(run['suite']), 'configuration': run['configurationDigest'], 'judge': run.get('judgeDigest'),
            'runtime': run.get('runtimeSnapshot'), 'selection': run.get('runtimeSelectionRevision'), 'builder': run.get('builderBindingId'), 'plan': task.get('planRevisionId')}), 'cases': cases}


def diagnosis_input(task, run, snapshot, context=None):
    context = context or {}
    if run['phase'] != 'development' or run['status'] == 'RUNNING':
        raise MigrationControlError('请选择已结束的开发集评测；留出集不进入修改诊断')
    if snapshot['digest'] != run['candidateDigest']:
        raise MigrationControlError('运行与工程快照不一致')
    candidate = next((item for item in task['candidates'] if item['id'] == run['candidateId']), {})
    group = completed_repetitions(task, run, 'effect') if run.get('repetition') else None
    runtime = run.get('runtimeFailureSnapshot') or run.get('runtimeSnapshot') or {}
    capabilities = runtime.get('capabilities')
    cases = []
    for case in suite_cases(run['suite']):
        result = next((item for item in run['cases'] if item['id'] == case['caseId']), None)
        evidence = (result or {}).get('evidence') or {}
        metadata = evidence.get('metadata') or {}
        process = metadata.get('process') or {}
        trace_complete = process.get('status') == 'COMPLETE' and 'tools' in process.get('scopes', []) if 'process' in metadata else (metadata.get('telemetry') or {}).get('status') == 'COMPLETE'
        repeated_pass = group and all(any(item['id'] == case['caseId'] and item['passed'] for item in other['cases']) for other in group)
        verdict = ('UNVERIFIED' if not group else 'PASS' if repeated_pass else 'FAIL') if run.get('repetition') else 'NOT_RUN' if not result else result.get('failureStage') or ('UNVERIFIED' if result.get('unverified') else 'PASS' if result['passed'] else 'FAIL')
        cases.append({'caseId': case['caseId'], 'task': case['prompt'], 'runtimeStatus': evidence.get('status', 'not_run'),
            'runtimeIdentityVerified': evidence.get('runtimeIdentityVerified', False), 'streamCompleted': evidence.get('streamCompleted', False),
            'toolTraceStatus': 'COMPLETE' if trace_complete else 'PARTIAL_OR_UNAVAILABLE',
            'toolCalls': [{key: call[key] for key in ('name', 'status')} for call in evidence.get('toolCalls', [])], 'review': (result or {}).get('reason'), 'verdict': verdict})
    return {'modelId': 'diagnosis', 'sourceJobId': run['id'], 'baseSolutionRevisionId': run['candidateDigest'],
        'tools': [{'toolId': tool['toolId'], 'name': tool['toolId'], 'form': tool['form']} for tool in candidate.get('tools', [])],
        'runtimeConfiguration': [], 'technicalEvidence': [], 'cases': cases,
        'codeEvidence': [{'origin': 'candidate', 'path': name, 'content': base64.b64decode(content).decode('utf-8', errors='replace')}
            for name, content in snapshot['files'].items() if re.search(r'\.(md|py|ts|js|json)$', name, re.I)],
        'evaluationEvidence': {'current': run['cases'], **({'baseline': context['baseline']['cases']} if context.get('baseline', {}).get('phase') == 'development' else {}),
            'basicValidation': {'runStatus': run['status'], 'effectStatus': run.get('effectStatus'), 'requirements': run.get('assessmentRequirements', []),
                'coverage': run.get('requirementCoverage', []), 'conformance': candidate.get('conformance')},
            **({'repetitions': [{'runId': other['id'], 'repetition': other['repetition'], 'status': other['status'], 'cases': other['cases']}
                for other in task['runs'] if other['phase'] == 'development' and other.get('repetition', {}).get('groupId') == run['repetition']['groupId']]} if run.get('repetition') else {})},
        'runtimeRequirements': {'requirements': [item for item in run.get('assessmentRequirements', []) if item['kind'] == 'RUNTIME'],
            'observed': {key: capabilities.get(key) for key in ('runtime', 'features', 'limits')} if capabilities else None},
        'approvedReuseDesign': {'goal': context.get('goal'), 'requirements': run.get('assessmentRequirements')}, 'previousExperiments': context.get('history')}
