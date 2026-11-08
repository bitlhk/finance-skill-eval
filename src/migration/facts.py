"""Observed identities and validity of task inputs; transitions live in control."""
from copy import deepcopy
from tasks.values import fingerprint
from runtime.build_admission import requirements_issues
from .state import MigrationControlError, milliseconds, now


def current_candidate(task):
    return next((item for item in task['candidates'] if item['id'] == task.get('currentCandidateId')), None)


def suite_value(suite):
    value = deepcopy(suite)
    if isinstance(value, dict):
        for key in ('cases', 'holdoutCases'):
            for item in value.get(key, []):
                item.pop('rationale', None)
    return value


def suite_digest(suite):
    return fingerprint(suite_value(suite))


def run_suite_matches(suite, run):
    return run['suiteDigest'] in (fingerprint(run['suite']), suite_digest(run['suite'])) and suite_digest(run['suite']) == suite_digest(suite)


def frozen_suite_matches(task, digest):
    return bool(digest and (digest in (suite_digest(task.get('suite')), fingerprint(task.get('suite'))) or any(
        run['suiteDigest'] == digest and run_suite_matches(task.get('suite'), run) for run in task['runs'])))


def completed_repetitions(task, run, purpose='acceptance'):
    group = run.get('repetition') or {}
    total = group.get('total', 1)
    if total != run.get('suite', {}).get('executionRepetitions', 1):
        return None
    runs = [item for item in task['runs'] if item.get('repetition', {}).get('groupId') == group['groupId']] if group else [run]
    if len(runs) != total or any((item.get('effectStatus', item['status']) if purpose == 'effect' else item['status']) not in ('PASSED', 'FAILED')
            or any(item.get(key) != run.get(key) for key in ('candidateDigest', 'configurationDigest', 'suiteDigest', 'judgeDigest', 'phase', 'purpose'))
            or fingerprint(item.get('runtimeSnapshot')) != fingerprint(run.get('runtimeSnapshot')) for item in runs):
        return None
    if group and (len({item['repetition']['index'] for item in runs}) != total or any(item['repetition']['total'] != total or not 1 <= item['repetition']['index'] <= total for item in runs)):
        return None
    return runs


def builder_status(task):
    selected = task.get('selectedRuntimeBuildRequestId')
    if not selected:
        return 'NONE'
    request = next((item for item in task.get('runtimeBuildRequests', []) if item['requirements']['requestId'] == selected), None)
    if not request:
        return 'STALE'
    binding = task.get('runtimeDelivery')
    if not binding or binding['requestId'] != selected:
        return 'PENDING'
    expires = binding['launcher'].get('expiresAt')
    if expires and milliseconds(expires) <= milliseconds(now()):
        return 'STALE'
    return 'BOUND' if binding['requirementsDigest'] == request['requirements']['requirementsDigest'] else 'STALE'


def require_binding(task, snapshot=None):
    if builder_status(task) in ('PENDING', 'STALE'):
        raise MigrationControlError('Runtime 交付尚未就绪或已失效，请接收有效交付或选择已有环境')
    if snapshot is None or not task.get('selectedRuntimeBuildRequestId'):
        return
    binding = task['runtimeDelivery']['launcher']
    if snapshot.get('launcherId') != binding['environmentId'] or any(snapshot.get('delivery', {}).get(key) != binding[key]
            for key in ('deploymentId', 'artifactSha256', 'resultDigest')) or fingerprint(snapshot.get('capabilities')) != binding['capabilitiesDigest']:
        raise MigrationControlError('Runtime deployment or capabilities changed; receive a new delivery')
    request = next(item for item in task['runtimeBuildRequests'] if item['requirements']['requestId'] == task['selectedRuntimeBuildRequestId'])
    issues = requirements_issues(request['requirements'], snapshot['capabilities'])
    if issues:
        raise MigrationControlError('Runtime requirements are not satisfied: ' + ', '.join(issues))


def input_issues(task, configuration, complete=False):
    standardization = (task.get('analysis') or {}).get('standardization') or {}
    declared = standardization.get('configurationInputs', [])
    values, issues = configuration.get('runtimeInputs', {}), []
    for name, value in values.items():
        field = next((item for item in declared if item['name'] == name), None)
        if not field:
            # The conversational main Agent publishes a prose migration plan.
            # An absent legacy structured plan cannot forbid authenticated
            # operators from configuring the actual tool environment. The
            # configuration contract and Launcher still validate names/values
            # and resolve credential references at the existing boundary.
            if declared:
                issues.append('配置不在当前方案中：' + name)
        elif field['sensitive'] != ('secretEnv' in value):
            issues.append(field['label'] + '：凭证需使用安全配置引用，普通配置填写实际值')
    def present(name):
        value = values.get(name, {})
        return bool(value.get('value', value.get('secretEnv', '')).strip())
    if complete:
        for field in declared:
            if field['required'] and not present(field['name']):
                issues.append('请补充' + field['label'] + '（' + field['name'] + '）')
        for group in standardization.get('configurationGroups', []):
            if not any(all(present(name) for name in option) for option in group['alternatives']):
                labels = {field['name']: field['label'] for field in declared}
                issues.append('请补充' + group['label'] + '（任选一组：' + '；或 '.join('、'.join(labels.get(name, name) for name in option) for option in group['alternatives']) + '）')
    return issues


def session_input_digest(task, run_id=None):
    return fingerprint({key: value for key, value in {
        'source': task['source'], 'goal': task['goal'], 'target': task['target'], 'inputKind': task.get('inputKind'),
        'projectNotes': task.get('projectNotes'), 'preparation': (task.get('preparations') or [None])[-1],
        'analysis': task.get('analysis'), 'currentCandidateId': task.get('currentCandidateId'), 'candidate': current_candidate(task),
        'configuration': task.get('configuration'), 'runtimeSelectionRevision': task.get('runtimeSelectionRevision'),
        'run': next((item for item in task['runs'] if item['id'] == run_id), None)}.items()})


def scope_digest(task):
    return fingerprint({key: task.get(key) for key in ('source', 'goal', 'target', 'inputKind', 'projectNotes')})


def run_configuration_current(task, run, judge_digest=None):
    configuration = task.get('baselineConfiguration' if run.get('purpose') == 'baseline' else 'configuration')
    if not configuration or not task.get('suite') or run['configurationDigest'] != fingerprint(configuration) or not run_suite_matches(task['suite'], run) or run.get('judgeDigest') != judge_digest:
        return False
    if run.get('purpose') == 'baseline':
        return True
    return (run.get('runtimeSelectionRevision') == task.get('runtimeSelectionRevision') and builder_status(task) not in ('PENDING', 'STALE')
            and run.get('builderBindingId') == (task.get('runtimeDelivery', {}).get('id') if task.get('selectedRuntimeBuildRequestId') else None))


def development_current(task, run, judge_digest=None):
    return run['phase'] == 'development' and run.get('purpose') != 'baseline' and run_configuration_current(task, run, judge_digest)


def control_inputs(task, judge_digest=None, digest=None):
    try:
        require_binding(task)
        binding_error = None
    except MigrationControlError as error:
        binding_error = str(error)
    candidate = current_candidate(task) or {}
    conformance = candidate.get('conformance') or {}
    allowed = bool(conformance.get('checks')) and ((conformance.get('evaluationDecision') or {}).get('decision') == 'PROCEED' if conformance.get('evaluationDecision') else not conformance.get('issues') and all(check['status'] != 'NEEDS_CHANGES' for check in conformance['checks']))
    return {'inputDigest': digest or session_input_digest(task), 'judgeDigest': judge_digest,
        'configurationDigest': fingerprint(task.get('configuration')), 'planDigest': fingerprint(task.get('analysis')),
        'builderStatus': builder_status(task), 'bindingError': binding_error,
        'runtimeInputIssues': input_issues(task, task['configuration'], True) if task.get('configuration') else [],
        'conformanceAllowed': not (task.get('analysis') or {}).get('standardization') or bool(candidate.get('draft') and not candidate.get('conformance')) or allowed,
        'frozenSuites': {item['id']: frozen_suite_matches(task, (item.get('optimizationInputs') or {}).get('suiteDigest')) for item in task['attempts']},
        'runs': {run['id']: {'suiteMatches': run_suite_matches(task.get('suite'), run), 'repetitionsComplete': bool(completed_repetitions(task, run, 'effect')),
            'holdoutUsed': any(other['phase'] == 'holdout' and run_suite_matches(run['suite'], other) for other in task['runs'])} for run in task['runs']}}
