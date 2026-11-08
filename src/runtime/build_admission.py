"""Builder delivery policy, using the same published contracts as Launcher calls."""
from collections import Counter
from copy import deepcopy
from tasks.values import fingerprint
from api.contracts import validate


def feature_issues(capabilities, features):
    return ['FEATURE_UNAVAILABLE_' + feature for feature in dict.fromkeys(features)
            if capabilities['features'].get(feature) is not True]


def requirements_issues(requirements, capabilities):
    issues = []
    if requirements['target']['runtimeType'] != capabilities['runtime']['type']:
        issues.append('RUNTIME_TYPE_MISMATCH')
    execution = requirements['executionRequirements']
    for key in ('os', 'arch', 'isolation'):
        if execution['platform'][key] != capabilities['platform'][key]:
            issues.append('PLATFORM_' + key.upper() + '_MISMATCH')
    issues.extend(feature_issues(capabilities, execution['features']))
    issues.extend('CAPACITY_INSUFFICIENT_' + key for key in ('maxFiles', 'maxArchiveBytes', 'maxTimeoutMs')
                  if execution['limits'][key] > capabilities['limits'][key])
    for requirement in requirements['requiredCapabilities']:
        if not requirement['required']:
            continue
        name = requirement.get('preferredTargetCapability') or requirement['name']
        matches = [item for item in capabilities.get('nativeCapabilities', []) if item['capabilityId'] == name or item['name'] == name]
        if len(matches) != 1:
            issues.append('CAPABILITY_NOT_DECLARED_' + requirement['id'])
            continue
        actual = matches[0]
        if fingerprint(actual['contract']) != fingerprint(requirement['contract']):
            issues.append('CONTRACT_INCOMPATIBLE_' + requirement['id'])
        def constraints(value):
            return {**value, 'permissions': sorted(set(value['permissions']))}
        if fingerprint(constraints(actual['constraints'])) != fingerprint(constraints(requirement['constraints'])):
            issues.append('CONSTRAINTS_INCOMPATIBLE_' + requirement['id'])
    return list(dict.fromkeys(issues))


def delivery_issues(requirements, result, capabilities):
    validate('build_requirements', requirements)
    validate('build_result', result)
    issues = []
    for document, field, issue in [(requirements, 'requirementsDigest', 'INVALID_REQUIREMENTS_DIGEST'),
                                   (result, 'resultDigest', 'INVALID_RESULT_DIGEST')]:
        body = deepcopy(document)
        digest = body.pop(field)
        if fingerprint(body) != digest:
            issues.append(issue)
    for key, issue in [('requestId', 'REQUEST_ID_MISMATCH'), ('requirementsDigest', 'REQUIREMENTS_DIGEST_MISMATCH')]:
        if result[key] != requirements[key]:
            issues.append(issue)
    if result['status'] != 'SUCCEEDED':
        issues.append('BUILD_STATUS_' + result['status'])
    if result['errors']:
        issues.append('BUILD_ERRORS_PRESENT')
    requirement_ids = [item['id'] for item in requirements['requiredCapabilities']]
    if len(set(requirement_ids)) != len(requirement_ids):
        issues.append('DUPLICATE_REQUIREMENT_IDS')
    counts = Counter(item['requirementId'] for item in result['capabilityResults'])
    for key, count in counts.items():
        if key not in requirement_ids:
            issues.append('UNKNOWN_REQUIREMENT_' + key)
        if count > 1:
            issues.append('DUPLICATE_REQUIREMENT_' + key)
    verifications = {item['id']: item for item in result['verifications']}
    if not any(item['type'] == 'RUNTIME_LIFECYCLE' and item['status'] == 'PASSED' and item.get('evidenceSha256') for item in result['verifications']):
        issues.append('RUNTIME_LIFECYCLE_NOT_VERIFIED')
    for requirement in requirements['requiredCapabilities']:
        if not requirement['required']:
            continue
        identifier = requirement['id']
        matches = [item for item in result['capabilityResults'] if item['requirementId'] == identifier]
        if len(matches) != 1:
            issues.append('REQUIREMENT_RESULT_COUNT_' + identifier)
            continue
        match = matches[0]
        if match['status'] != 'IMPLEMENTED':
            issues.append('REQUIREMENT_NOT_IMPLEMENTED_' + identifier)
        if match.get('contractDigest') != fingerprint(requirement['contract']):
            issues.append('CONTRACT_INCOMPATIBLE_' + identifier)
        if not match['verificationIds'] or any(verifications.get(key, {}).get('status') != 'PASSED' for key in match['verificationIds']):
            issues.append('VERIFICATION_NOT_PASSED_' + identifier)
    launcher = result['launcher']
    if not launcher:
        issues.append('LAUNCHER_UNAVAILABLE')
    else:
        baseline = (requirements.get('rebuild') or {}).get('baseline', {})
        for key, issue in [('deploymentId', 'REBUILD_DEPLOYMENT_UNCHANGED'), ('artifactSha256', 'REBUILD_ARTIFACT_UNCHANGED')]:
            if baseline.get(key) == launcher[key]:
                issues.append(issue)
        if launcher['runtime']['type'] != requirements['target']['runtimeType']:
            issues.append('RUNTIME_TYPE_MISMATCH')
        for key, value in requirements['target']['protocols'].items():
            if launcher['protocols'].get(key) != value:
                issues.append('PROTOCOL_MISMATCH_' + key.upper())
        issues.extend(requirements_issues(requirements, capabilities))
        for key in ('type', 'version'):
            if capabilities['runtime'][key] != launcher['runtime'][key]:
                issues.append('LAUNCHER_RUNTIME_' + key.upper() + '_MISMATCH')
        if fingerprint(capabilities) != launcher['capabilitiesDigest']:
            issues.append('LAUNCHER_CAPABILITIES_DIGEST_MISMATCH')
        if not capabilities.get('observability'):
            issues.append('LAUNCHER_OBSERVABILITY_NOT_DECLARED')
    return list(dict.fromkeys(issues))
