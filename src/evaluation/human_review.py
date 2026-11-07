"""Append-only human annotations, dispute resolution and Judge calibration."""
import asyncio
from copy import deepcopy
from uuid import uuid4
from pathlib import Path
from api.contracts import parse
from evaluation.checks import read_pointer
from storage.repository import TaskRepository
from storage.tasks import read_json, write_json
from tasks.values import canonical_fingerprint as fingerprint, now


OUTCOMES = ['PASS', 'FAIL', 'UNVERIFIED']


def migration_targets(run):
    targets = []
    for index, case in enumerate(run['cases']):
        root = '/cases/' + str(index)
        def add(suffix, label, scope, machine):
            targets.append({'id': root + suffix, 'caseId': case['id'], 'label': label,
                'scope': scope, 'machine': machine, 'outcomes': OUTCOMES[:], 'evidenceRoot': root})
        add('', '案例结论', 'case', None if case.get('failureStage') or case.get('unverified') else 'PASS' if case.get('passed') else 'FAIL')
        for position, criterion in enumerate(case.get('criteria', [])):
            add('/criteria/' + str(position), criterion['id'], 'criterion', None if criterion['passed'] is None else 'PASS' if criterion['passed'] else 'FAIL')
        for position, method in enumerate(case.get('methodResults', [])):
            add('/methodResults/' + str(position), method['methodId'], 'method', verdict(method['status']))
    return targets


def verdict(value):
    return value if value in ('PASS', 'FAIL') else None


def comparison_targets(report):
    targets = []
    for index, case in enumerate(report['cases']):
        root = '/cases/' + str(index)
        def add(suffix, label, machine, scope='case', outcomes=None):
            targets.append({'id': root + suffix, 'caseId': case['caseId'], 'label': label, 'machine': machine,
                'scope': scope, 'outcomes': outcomes or OUTCOMES[:], 'evidenceRoot': root})
        judge = case.get('judge') or {}
        if judge.get('runtimeComparison'):
            for side in ('left', 'right'):
                result = judge['runtimeComparison'][side]
                add('/judge/runtimeComparison/' + side, side, verdict(result['assessment']['verdict']) if result['status'] == 'assessed' else None)
        elif judge.get('goalAssessment') or judge.get('serviceComparison'):
            key = 'goalAssessment' if judge.get('goalAssessment') else 'serviceComparison'
            assessment = judge[key]
            add('/judge/' + key, '业务结论', verdict(assessment['verdict']))
            for position, check in enumerate(assessment['checks']):
                add('/judge/' + key + '/checks/' + str(position), check['criterion'], verdict(check['verdict']), 'criterion')
        elif judge.get('winner'):
            add('/judge/winner', '两侧回答偏好（不等于业务达标）', judge['winner'], 'pairwise', ['left', 'right', 'tie', 'UNVERIFIED'])
        for side in ('left', 'right'):
            for position, method in enumerate((case.get('methodResults') or {}).get(side, [])):
                add('/methodResults/' + side + '/' + str(position), side + ' · ' + method['methodId'], verdict(method['status']), 'method')
    return targets


def consensus(target, records):
    scoped = [record for record in records if record['targetId'] == target['id']]
    replaced = {record.get('supersedes') for record in scoped}
    annotations = [record for record in scoped if record['kind'] == 'ANNOTATION' and record['id'] not in replaced]
    ids = sorted(record['id'] for record in annotations)
    decision = next((record for record in reversed(scoped) if record['kind'] == 'ADJUDICATION' and ids and sorted(record['resolves']) == ids), None)
    outcomes = {record['outcome'] for record in annotations}
    return {'annotations': annotations, 'decision': decision,
        'outcome': decision['outcome'] if decision else next(iter(outcomes)) if len(outcomes) == 1 else None,
        'disputed': not decision and len(outcomes) > 1}


def summary(targets, records):
    result = []
    for scope in ('case', 'criterion', 'pairwise', 'method'):
        selected = [target for target in targets if target['scope'] == scope]
        counts = dict(scope=scope, total=len(selected), reviewed=0, disputed=0, comparable=0, agree=0, machineMissing=0, humanUnverified=0)
        for target in selected:
            value = consensus(target, records)
            if not value['annotations']:
                continue
            counts['reviewed'] += 1
            if value['disputed']:
                counts['disputed'] += 1
            elif value['outcome'] in (None, 'UNVERIFIED'):
                counts['humanUnverified'] += 1
            elif target['machine'] is None:
                counts['machineMissing'] += 1
            else:
                counts['comparable'] += 1
                counts['agree'] += value['outcome'] == target['machine']
        counts.update(unreviewed=counts['total'] - counts['reviewed'], disagree=counts['comparable'] - counts['agree'],
            agreement=counts['agree'] / counts['comparable'] if counts['comparable'] else None)
        result.append(counts)
    return result


def calibrations(base, records, evaluations):
    key = lambda target: (target['caseId'], target['scope'], target['label'])
    results = []
    for evaluation in evaluations:
        targets = evaluation['targets']
        ambiguous = len({key(target) for target in base}) != len(base) or len({key(target) for target in targets}) != len(targets)
        aligned = []
        for target in base:
            match = next((item for item in targets if key(item) == key(target)), None)
            aligned.append({**target, 'machine': match['machine'] if match and match['outcomes'] == target['outcomes'] else None})
        compatible = evaluation['compatible'] and not ambiguous
        results.append({**{name: evaluation.get(name) for name in ('id', 'label', 'judgeIdentity')}, 'compatible': compatible,
            'reason': '判定项标识重复，不能可靠匹配' if ambiguous else evaluation.get('reason'),
            'summary': summary(aligned, records) if compatible else [],
            'missingTargets': sum(not any(key(other) == key(target) for other in targets) for target in base),
            'additionalTargets': sum(not any(key(other) == key(target) for other in base) for target in targets)})
    return results


def comparison_calibrations(job):
    source, result = job['report'], []
    for record in job.get('rescorings', []):
        for index, attempt in enumerate(record.get('attempts', [{'cases': record['cases'] if 'cases' in record else []}])):
            compatible = record['sourceReportFingerprint'] == source['reportFingerprint']
            for case in attempt['cases']:
                original = next((item for item in source['cases'] if item['caseId'] == case['caseId']), None)
                compatible = compatible and bool(original) and all(fingerprint(original[side]) == fingerprint(case[side]) for side in ('left', 'right'))
            result.append({'id': record['id'] + ':' + str(index), 'label': f"{record['createdAt']} · 第 {index + 1} 次",
                'judgeIdentity': record.get('judgeConfigurationDigest', record['judgeId']), 'compatible': compatible,
                'reason': None if compatible else '重评与原报告的执行证据不一致', 'targets': comparison_targets({**source, 'cases': attempt['cases']})})
    return result


def migration_calibrations(run, records):
    results = []
    for record in records:
        if record['sourceRunId'] != run['id']:
            continue
        for index, attempt in enumerate(record.get('attempts', [record])):
            cases = run['suite'].get('holdoutCases', []) if run['phase'] == 'holdout' else run['suite']['cases']
            same_plan = not record.get('plan') or all(fingerprint(case.get('evaluationPlan')) == fingerprint(record['plan']) for case in cases)
            same_evidence = attempt.get('sourceDigest') == fingerprint(run)
            for case in attempt['cases']:
                original = next((item for item in run['cases'] if item['id'] == case['id']), None)
                same_evidence = same_evidence and bool(original and original.get('evidence')) and case.get('evidenceDigest') == fingerprint(original['evidence'])
            results.append({'id': record['id'] + ':' + str(index), 'label': f"{record['createdAt']} · 第 {index + 1} 次",
                'judgeIdentity': attempt.get('judgeDigest', '未保存 Judge 身份'), 'compatible': bool(same_plan and same_evidence),
                'reason': '评测方案已变化，不沿用旧标准的人工标注' if not same_plan else '无法核对原始证据关联' if not same_evidence else None,
                'targets': migration_targets({'cases': [{**case, 'passed': case['status'] == 'PASS', 'unverified': case['status'] == 'UNVERIFIED'} for case in attempt['cases']]})})
    return results


class HumanReviewStore:
    def __init__(self, root, resolve):
        self.root, self.resolve = Path(root), resolve
        self.repository = TaskRepository(root)

    def file(self, source):
        return self.root / 'evaluation-reviews' / (fingerprint(source) + '.json')

    async def records(self, source):
        try:
            return await asyncio.to_thread(read_json, self.file(source))
        except FileNotFoundError:
            return []

    async def get(self, source):
        source = parse('review_source', source)
        material = await self.resolve(source)
        history = await self.records(source)
        records = [record for record in history if record['sourceDigest'] == material['digest']]
        return {'source': source, 'sourceDigest': material['digest'], 'targets': material['targets'], 'records': records, 'history': history,
            'staleRecordCount': len(history) - len(records), 'consensus': {target['id']: consensus(target, records) for target in material['targets']},
            'summary': summary(material['targets'], records), 'evidence': material['resources'],
            'calibrations': calibrations(material['targets'], records, material.get('evaluations', []))}

    async def append(self, value):
        from storage.coordination import CoordinationConflict
        request = parse('review_import', value)
        key = 'human-review:' + fingerprint(request['source'])
        token = await self.repository.acquire(key, 5000)
        if not token:
            raise CoordinationConflict('其他请求正在更新复核意见')
        try:
            material = await self.resolve(request['source'])
            if material['digest'] != request['sourceDigest']:
                raise CoordinationConflict('评测材料已变化，请刷新后复核')
            history = await self.records(request['source'])
            if len(history) + len(request['entries']) > 10000:
                raise CoordinationConflict('复核历史已达保存上限')
            current, added = [record for record in history if record['sourceDigest'] == material['digest']], []
            missing = object()
            for entry in request['entries']:
                target = next((target for target in material['targets'] if target['id'] == entry['targetId']), None)
                if not target or entry['outcome'] not in target['outcomes']:
                    raise ValueError('标注目标或结论不适用于当前报告')
                if any(not ref.startswith(target['evidenceRoot'] + '/') or read_pointer(material['resources'], ref, missing) is missing for ref in entry['evidenceRefs']):
                    raise ValueError('引用必须指向该案例中实际保存的证据')
                agreed = consensus(target, current + added)
                if entry['kind'] == 'ANNOTATION':
                    previous = next((record for record in agreed['annotations'] if record['reviewer'] == entry['reviewer']), {})
                    if previous.get('id') != entry.get('supersedes') or entry['resolves']:
                        raise CoordinationConflict('标注意见已变化；修改时必须引用该标注者的当前记录')
                elif entry.get('supersedes') or len(agreed['annotations']) < 2 or len({record['outcome'] for record in agreed['annotations']}) < 2 or sorted(entry['resolves']) != sorted(record['id'] for record in agreed['annotations']):
                    raise CoordinationConflict('争议复核必须引用全部当前分歧意见')
                added.append({**deepcopy(entry), 'id': str(uuid4()), 'createdAt': now(), 'sourceDigest': material['digest']})
            if (await self.resolve(request['source']))['digest'] != material['digest']:
                raise CoordinationConflict('保存前评测材料已变化')
            await asyncio.to_thread(write_json, self.file(request['source']), history + added)
            return await self.get(request['source'])
        finally:
            await self.repository.release(key, token)
