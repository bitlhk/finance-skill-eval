"""Deterministic checks over one frozen JSON evidence value."""
import json
import math
import hashlib
import re
import sys


def json_equal(left, right):
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is type(right) and left == right
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, list):
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(json_equal(left[k], right[k]) for k in left)
    return left == right


def evaluate_rule(rule, actual):
    operation = rule['operation']
    if operation == 'exists':
        return True
    if operation == 'equals':
        return json_equal(actual, rule['expected'])
    if operation == 'contains':
        return (rule['expected'] in actual if isinstance(actual, str) else
                any(json_equal(item, rule['expected']) for item in actual) if isinstance(actual, list) else False)
    if operation == 'numeric_tolerance':
        if isinstance(actual, bool) or not isinstance(actual, (int, float)) or not math.isfinite(actual):
            return False
        expected = rule['expected']
        return abs(actual - expected) <= max(rule['absoluteTolerance'], rule['relativeTolerance'] * abs(expected))
    if operation == 'set_equals':
        if not isinstance(actual, list) or any(not isinstance(v, (str, int, float, bool)) for v in actual):
            return False
        expected = rule['expected']
        return (all(any(json_equal(v, other) for other in expected) for v in actual)
                and all(any(json_equal(v, other) for other in actual) for v in expected))
    raise ValueError('Unsupported rule operation')


def read_pointer(value, reference, missing=None):
    if reference == '':
        return value
    if not reference.startswith('/'):
        return missing
    for encoded in reference[1:].split('/'):
        part = encoded.replace('~1', '/').replace('~0', '~')
        if part in ('__proto__', 'prototype', 'constructor'):
            return missing
        if isinstance(value, dict):
            if part not in value:
                return missing
            value = value[part]
        elif isinstance(value, list):
            if part == 'length':
                value = len(value)
                continue
            if not part.isascii() or not part.isdigit() or (len(part) > 1 and part[0] == '0'):
                return missing
            index = int(part)
            if index >= len(value):
                return missing
            value = value[index]
        else:
            return missing
    return value


def evaluate_check(check, resources):
    rule = check['rule']
    references = [*check.get('evidenceRefs', []), rule['reference']]
    if any(read_pointer(resources, reference) is None for reference in references):
        return {'id': check['id'], 'status': 'UNVERIFIED', 'reason': 'Required evidence is unavailable', 'evidenceRefs': []}
    passed = evaluate_rule(rule, read_pointer(resources, rule['reference']))
    return {'id': check['id'], 'status': 'PASS' if passed else 'FAIL',
            'reason': rule['operation'] + ': ' + rule['reference'], 'evidenceRefs': [rule['reference']]}


def check_references(references, resources):
    return {'available': all(read_pointer(resources, reference) is not None for reference in references)}


def validate_citations(result, resources):
    if not isinstance(result, dict) or set(result) != {'checks'}:
        raise ValueError('Invalid verifier result')
    checks = result['checks']
    if not isinstance(checks, list) or not 1 <= len(checks) <= 64:
        raise ValueError('Invalid verifier checks')
    validated = []
    for check in checks:
        if not isinstance(check, dict) or not set(check) <= {'id', 'status', 'reason', 'evidenceRefs', 'score'}:
            raise ValueError('Invalid verifier check')
        if (not isinstance(check.get('id'), str) or not check['id']
                or check.get('status') not in ('PASS', 'FAIL', 'UNVERIFIED')
                or not isinstance(check.get('reason'), str) or not check['reason']):
            raise ValueError('Invalid verifier check')
        refs = check.get('evidenceRefs', [])
        if not isinstance(refs, list) or any(not isinstance(ref, str) or not ref for ref in refs):
            raise ValueError('Invalid verifier evidence references')
        if 'score' in check:
            score = check['score']
            if isinstance(score, bool) or not isinstance(score, (int, float)) or not math.isfinite(score) or not 0 <= score <= 1:
                raise ValueError('Invalid verifier score')
        if not check_references(refs, resources)['available']:
            raise ValueError('Judge cited unavailable evidence')
        normalized = {**check, 'evidenceRefs': refs}
        if check['status'] != 'UNVERIFIED' and not refs:
            normalized.update(status='UNVERIFIED', reason='Missing evidence citations: ' + check['reason'])
        validated.append(normalized)
    return {'checks': validated}


def validate_artifacts(artifacts):
    if not isinstance(artifacts, list) or len(artifacts) > 32:
        return {'artifacts': None}
    paths = set()
    for artifact in artifacts:
        if not isinstance(artifact, dict) or not set(artifact) <= {'path', 'content', 'sha256', 'source'}:
            return {'artifacts': None}
        path, source, digest = artifact.get('path'), artifact.get('source'), artifact.get('sha256')
        def valid_string(value, limit):
            return isinstance(value, str) and 0 < len(value.encode('utf-16-le', errors='surrogatepass')) // 2 <= limit
        if (not valid_string(path, 500) or not valid_string(source, 100)
                or not isinstance(digest, str) or not re.fullmatch(r'[a-f0-9]{64}', digest) or path in paths):
            return {'artifacts': None}
        paths.add(path)
        if 'content' in artifact:
            content = artifact['content']
            if not isinstance(content, str) or len(content.encode('utf-16-le', errors='surrogatepass')) // 2 > 64000:
                return {'artifacts': None}
            encoded = content.encode('utf-16-le', errors='surrogatepass').decode('utf-16-le', errors='replace').encode('utf-8')
            if hashlib.sha256(encoded).hexdigest() != digest:
                return {'artifacts': None}
    return {'artifacts': artifacts}


def execution_checks(evidence, expected=None):
    """Check execution identity/completeness independently from answer quality."""
    metadata = evidence.get('metadata') or {}
    checks = [
        {'id': 'execution.completed', 'status': 'PASS' if evidence['status'] == 'completed' else 'FAIL', 'reason': evidence['status']},
        {'id': 'execution.stream', 'status': 'PASS' if evidence.get('streamCompleted') else 'UNVERIFIED', 'reason': '执行流完整性'},
        {'id': 'execution.identity', 'status': 'PASS' if evidence.get('runtimeIdentityVerified') else 'UNVERIFIED', 'reason': '运行身份核验'},
    ]
    if 'caseState' in metadata:
        checks.append({'id': 'execution.business-state', 'status': 'PASS' if (metadata['caseState'] or {}).get('status') == 'COMPLETE' else 'UNVERIFIED',
                       'reason': '业务初态、最终状态采集与恢复', 'evidenceRefs': ['/execution/caseState']})
    if expected is not None:
        project = expected.get('executionMode') == 'agent_project'
        if project:
            checks.append({'id': 'execution.project', 'status': 'PASS' if metadata.get('projectExecution') is True else 'UNVERIFIED',
                           'reason': '完整 Agent 工程执行核验；内部 Skill 的使用需由过程证据另行判断'})
        checks.append({'id': 'execution.artifact', 'status': 'PASS' if metadata.get('contentDigest') == expected['contentDigest'] else 'UNVERIFIED',
                       'reason': '候选摘要核验'})
        for member in [] if project else expected['members']:
            loaded = any(skill['skillId'] == member['skillId'] and skill['version'] == member['version'] for skill in evidence['loadedSkills'])
            checks.append({'id': 'execution.skill:' + member['skillId'] + '@' + member['version'],
                           'status': 'PASS' if loaded else 'UNVERIFIED', 'reason': 'Skill 组装载核验'})
    return checks


def comparison_incomplete(report):
    if not report['cases']:
        return True
    for case in report['cases']:
        judge = case.get('judge') or {}
        if not judge or case.get('judgeError'):
            return True
        if any(check['status'] != 'PASS' for side in ('left', 'right') for check in execution_checks(case[side])):
            return True
        if any(method['status'] not in ('PASS', 'FAIL') for methods in case.get('methodResults', {}).values() for method in methods):
            return True
        if any((judge.get(key) or {}).get('verdict') == 'INDETERMINATE' for key in ('goalAssessment', 'serviceComparison')):
            return True
        if any(item['status'] != 'assessed' or item['assessment']['verdict'] == 'INDETERMINATE'
               for item in judge.get('runtimeComparison', {}).values()):
            return True
    return False


def execute(request):
    action = request.get('action', 'rule')
    if action == 'rule':
        result = evaluate_check(request['check'], request['resources'])
    elif action == 'check_refs':
        result = check_references(request['references'], request['resources'])
    elif action == 'validate_citations':
        result = validate_citations(request['result'], request['resources'])
    elif action == 'validate_artifacts':
        result = validate_artifacts(request['artifacts'])
    elif action == 'execution':
        result = execution_checks(request['evidence'], request.get('expected'))
    elif action == 'comparison_incomplete':
        result = comparison_incomplete(request['report'])
    else:
        raise ValueError('Unsupported evaluation action')
    return result


def main():
    json.dump(execute(json.load(sys.stdin)), sys.stdout, allow_nan=False)


if __name__ == '__main__':
    main()
