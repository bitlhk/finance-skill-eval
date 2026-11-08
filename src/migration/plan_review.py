"""Compare declared Runtime support with the approved plan; prose stays unverified."""
from runtime.contracts import validate
from runtime.build_admission import requirements_issues
from tasks.values import fingerprint, now


def review_environment(task, environment):
    capabilities = environment.get('capabilities') if isinstance(environment, dict) else None
    try:
        validate('finance.runtime-capabilities.v1', capabilities)
    except ValueError:
        capabilities = None
    analysis = task.get('analysis') or {}
    plan, items = analysis.get('plan'), []
    if not plan:
        items.append({'name': '方案中的运行要求', 'status': 'UNVERIFIED', 'reason': '原记录未提供完整的结构化运行要求；启动成功不代表所有依赖均已满足。'})
    else:
        configuration = task.get('configuration') or {}
        standardization = analysis.get('standardization') or {}
        def supplied(name):
            value = configuration.get('runtimeInputs', {}).get(name, {})
            return bool(value.get('value', value.get('secretEnv', '')).strip())
        groups = standardization.get('configurationGroups', [])
        for field in standardization.get('configurationInputs', []):
            provided = supplied(field['name'])
            alternatives = [group for group in groups if any(field['name'] in option for option in group['alternatives'])]
            covered = bool(alternatives) and all(any(all(supplied(name) for name in option) for option in group['alternatives']) for group in alternatives)
            reason = '配置已提供，仍需验证连接和业务调用。' if provided else '已填写同组的其他完整配置，本项无需重复提供。' if covered else field['description'] + (
                '；请在本页补充。' if field['required'] else '；请按配置组选择一组完整填写。' if alternatives else '；此项可选。')
            items.append({'name': field['label'], 'status': 'UNSATISFIED' if not provided and field['required'] else 'UNVERIFIED', 'reason': reason})
        for group in groups:
            if not any(all(supplied(name) for name in option) for option in group['alternatives']):
                items.append({'name': group['label'], 'status': 'UNSATISFIED', 'reason': '请任选一组完整填写；不同组的零散配置不能组合替代。'})
        for required in plan.get('runtimeFeatures', []):
            missing = capabilities is None or capabilities['features'].get(required['feature']) is not True
            items.append({'name': required['feature'], 'status': 'UNVERIFIED' if capabilities is None else ('UNSATISFIED' if required['required'] else 'UNVERIFIED') if missing else 'SATISFIED',
                'reason': required['reason'] + ('；当前 Runtime 未证明支持，需适配、构建或选择支持该能力的 Runtime。' if missing else '；Runtime 已声明支持，仍需实际调用验证。')})
        for required in plan['requiredCapabilities']:
            if capabilities is None:
                items.append({'name': required['name'], 'status': 'UNVERIFIED', 'reason': '环境未提供可核对的能力说明。'})
                continue
            requirements = {'target': {'runtimeType': capabilities['runtime']['type']},
                'executionRequirements': {'platform': capabilities['platform'], 'features': [],
                    'limits': {'maxFiles': 1, 'maxArchiveBytes': 1, 'maxTimeoutMs': configuration['timeoutMs']}}, 'requiredCapabilities': [{**required, 'required': True}]}
            issues = requirements_issues(requirements, capabilities)
            items.append({'name': required['name'], 'status': ('UNSATISFIED' if required['required'] else 'UNVERIFIED') if issues else 'SATISFIED',
                'reason': ('已登记能力与方案要求不一致或缺失。' if required['required'] else '此可选能力尚未确认可用。') if issues else '能力接口、约束与方案要求一致；实际调用仍需验证。'})
        for dependency in plan['dependencies']:
            if not any(item['id'] == dependency['key'] for item in plan['requiredCapabilities']):
                items.append({'name': dependency['name'], 'status': 'UNVERIFIED', 'reason': dependency['contract'] + '；' + dependency['configuration']})
        for condition in plan['conditions']:
            items.append({'name': condition, 'status': 'UNVERIFIED', 'reason': '此运行条件需通过实际调用或外部证据核验，不能仅凭环境登记确认。'})
        if not items:
            items.append({'name': '运行环境连接与启动协议', 'status': 'SATISFIED' if capabilities else 'UNVERIFIED',
                'reason': '环境已返回有效协议说明；实例启动及业务效果需继续验证。' if capabilities else '环境未提供可核对的协议说明。'})
    return {'candidateId': task.get('currentCandidateId'), 'configurationDigest': fingerprint(task.get('configuration')),
        **({'planDigest': fingerprint(task['analysis'])} if task.get('analysis') else {}),
        **({'runtimeSelectionRevision': task['runtimeSelectionRevision']} if 'runtimeSelectionRevision' in task else {}),
        'checkedAt': now(), 'environmentDigest': fingerprint(environment), 'items': items,
        'status': 'FAILED' if any(item['status'] == 'UNSATISFIED' for item in items) else 'INCOMPLETE' if any(item['status'] == 'UNVERIFIED' for item in items) else 'PASSED'}
