"""Eval Pack catalog and prepared datasets using the existing persisted formats."""
from copy import deepcopy
from pathlib import Path
import re
from uuid import uuid4
import yaml

from api.contracts import parse
from storage.tasks import read_json, write_json
from tasks.values import fingerprint, now


def load_pack(file):
    file = Path(file).resolve()
    def load(relative):
        target = (file.parent / relative).resolve()
        if not target.is_relative_to(file.parent):
            raise ValueError('Eval Pack path escapes its directory')
        return yaml.safe_load(target.read_text(encoding='utf-8'))
    source = parse('eval_pack', yaml.safe_load(file.read_text(encoding='utf-8')))
    profile = parse('judge_profile', load(source['judgeProfileFile']))
    cases = [parse('eval_case', load(name)) for name in source['caseFiles']]
    holdout = [parse('eval_case', load(name)) for name in source.get('holdoutCaseFiles', [])]
    identifiers = [item['caseId'] for item in cases + holdout]
    if len(set(identifiers)) != len(identifiers):
        raise ValueError('Duplicate caseId in Eval Pack')
    body = {'pack': source, 'cases': cases, **({'holdoutCases': holdout} if holdout else {}), 'judgeProfile': profile}
    return {**source, 'sourceFile': str(file), 'cases': cases, **({'holdoutCases': holdout} if holdout else {}),
            'judgeProfile': profile, 'packFingerprint': fingerprint(body)}


def pack_priority(pack):
    return 2 if all(case.get('replay') for case in pack['cases']) else 0 if pack.get('metadata', {}).get('dataMode') == 'synthetic-snapshot' else 1


class EvalPackCatalog:
    def __init__(self, root):
        self.directory = Path(root) / 'packs/finance'

    def packs(self):
        packs = [load_pack(file) for file in self.directory.glob('*/eval.yaml')]
        if len({item['packId'] for item in packs}) != len(packs):
            raise ValueError('Duplicate Eval Pack identity')
        return sorted(packs, key=pack_priority)

    def get(self, identifier):
        return next((pack for pack in self.packs() if pack['packId'] == identifier), None)

    def list(self):
        return [{**{key: pack[key] for key in ('packId', 'version', 'domain', 'targetSkillId', 'targetSkillVersion', 'description', 'variants')},
            'caseCount': len(pack['cases']), 'holdoutCaseCount': len(pack.get('holdoutCases', [])),
            'holdoutRequiredTools': sorted({tool for case in pack.get('holdoutCases', []) for tool in case['requiredTools']}),
            'cases': [{key: case[key] for key in ('caseId', 'name', 'prompt', 'evaluationGoal', 'requiredTools')} for case in pack['cases']],
            'replayReady': all(case.get('replay') for case in pack['cases']),
            'deterministicReady': all(all(rule['allOf'] or rule['anyOf'] or rule['noneOf'] for rule in case['rubric']) for case in pack['cases']),
            'fingerprint': pack['packFingerprint'], 'models': {'execution': pack['models']['execution']}} for pack in self.packs()]

    def featured(self, online):
        file = self.directory / 'catalog.yaml'
        definitions = yaml.safe_load(file.read_text(encoding='utf-8'))['skills'] if file.is_file() else []
        result = []
        for definition in definitions:
            packs = [pack for pack in self.packs() if pack['targetSkillId'] == definition['skillId']]
            versions = [{'version': pack['targetSkillVersion'], 'packId': pack['packId'], 'packVersion': pack['version'],
                'replayReady': all(case.get('replay') for case in pack['cases']),
                'artifactSha256': pack['variants']['right'].get('artifactSha256') if pack['variants']['right']['mode'] == 'skill_version' else None} for pack in packs]
            cases = packs[0]['cases'] if packs else []
            result.append({**definition, 'versions': versions, 'taskCount': len(cases),
                'requiredTools': sorted({tool for case in cases for tool in case['requiredTools']}),
                'evaluationStatus': 'pack_required' if not packs else 'ready' if online or any(version['replayReady'] for version in versions) else 'environment_required'})
        return sorted(result, key=lambda item: item['featuredOrder'])


def suite_cases(suite, *, holdout=False):
    suite = parse('migration_suite', suite)
    identifiers = [item['id'] for item in suite['cases'] + suite.get('holdoutCases', [])]
    if len(identifiers) != len(set(identifiers)):
        raise ValueError('开发题与留出题的 id 不能重复')
    if suite.get('executionRepetitions', 1) > 1 and any(not item.get('stateFixture') and item.get('repeatSafety') != 'read_only'
            for item in suite['cases'] + suite.get('holdoutCases', [])):
        raise ValueError('重复业务运行需要版本化状态初态与恢复，或明确声明只读案例')
    result = []
    for item in suite.get('holdoutCases', []) if holdout else suite['cases']:
        scopes = item.get('criterionScopes', [])
        if scopes and len(scopes) != len(item['criteria']):
            raise ValueError('criterionScopes must match criteria length')
        files = {file['path']: file for file in suite.get('workspaceFiles', []) + item.get('workspaceFiles', [])}
        turns = item.get('turns', [])
        result.append(parse('eval_case', {'caseId': item['id'], 'name': item['id'],
            'prompt': turns[0]['query'] if len(turns) == 1 else item['input'], 'evaluationGoal': '\n'.join(item['criteria']),
            'requiredTools': list(dict.fromkeys(tool for turn in turns for tool in turn.get('requiredTools', []))),
            **({'turns': turns, 'taskMode': 'multi_turn'} if len(turns) > 1 else {}),
            **({'workspaceFiles': [files[key] for key in sorted(files)]} if files else {}),
            **{key: item[key] for key in ('evaluationPlan', 'stateFixture') if key in item},
            'rubric': [{'criterionId': 'goal-' + str(index + 1), 'label': description, 'description': description,
                'dimension': 'business_completeness', 'weight': 1, 'required': True,
                **({'scope': scopes[index]} if scopes else {})} for index, description in enumerate(item['criteria'])]}))
    return result


class PreparationStore:
    def __init__(self, root):
        self.directory = Path(root) / 'preparations'

    def list(self):
        return sorted((read_json(file) for file in self.directory.glob('*.json')), key=lambda item: item['createdAt'], reverse=True)

    def get(self, identifier):
        if not isinstance(identifier, str) or not re.fullmatch('[a-z0-9-]+', identifier):
            return None
        try:
            return read_json(self.directory / (identifier + '.json'))
        except FileNotFoundError:
            return None

    def create(self, skill, summary, cases, *, holdout=None, source='manual', context=None, **options):
        record = {'schemaVersion': 'finance.skill-eval.preparation.v1', 'preparationId': 'prep-' + str(uuid4())[:12],
            'skillAssetId': skill['assetId'], 'skillId': skill['skillId'], 'skillVersion': skill['version'],
            'summary': summary, 'cases': cases, 'holdoutCases': holdout or [], 'source': source,
            'evaluationContext': context, 'createdAt': now(), **options}
        write_json(self.directory / (record['preparationId'] + '.json'), record)
        return record

    def build_pack(self, preparation, analyzer, execution, judge):
        pack = {'schemaVersion': 'finance.skill-eval.pack.v1', 'packId': 'uploaded-' + preparation['preparationId'],
            'version': '1.0.0', 'domain': 'uploaded-skill', 'targetSkillId': preparation['skillId'],
            'targetSkillVersion': preparation['skillVersion'], 'description': preparation['summary'],
            'models': {'analyzer': analyzer, 'execution': {'left': execution, 'right': execution}, 'judge': judge},
            'variants': {'left': {'mode': 'without_target_skill', 'skillId': preparation['skillId']},
                         'right': {'mode': 'skill_version', 'skillId': preparation['skillId'], 'version': preparation['skillVersion']}},
            'judgeProfileFile': 'generated', 'caseFiles': [], 'metadata': {'source': preparation['source'],
                'preparationId': preparation['preparationId'], **({'assessmentMode': preparation['assessmentMode']} if preparation.get('assessmentMode') else {}),
                **({'comparisonOnly': 'true'} if preparation.get('comparisonOnly') else {})}}
        profile = {'schemaVersion': 'finance.skill-eval.judge-profile.v1', 'profileId': 'generic-finance-skill-value-judge',
            'version': '1.0.0', 'reviewerLabel': '金融 Skill 专业价值 Judge',
            'domainInstructions': '判断 Skill 是否实质提升专业判断，而不是只增加篇幅或规则复述。\n重点比较业务问题识别、结果完整性、表达清晰度和下一步可执行性。\n没有来源的事实、数字或工具执行结果不得获得奖励。',
            'dimensions': [{'id': key, 'label': label, 'description': description} for key, label, description in [
                ('professional_fit', '专业匹配度', '是否体现岗位专业判断'), ('business_completeness', '业务完整性', '是否覆盖任务所需闭环'),
                ('clarity', '结构与清晰度', '是否易于理解和使用'), ('actionability', '可执行性', '是否形成明确下一步')]]}
        cases, holdout = preparation['cases'], preparation.get('holdoutCases', [])
        return {**pack, 'sourceFile': str(self.directory / (preparation['preparationId'] + '.json')), 'cases': deepcopy(cases),
            'holdoutCases': deepcopy(holdout), 'judgeProfile': profile,
            'packFingerprint': fingerprint({'pack': pack, 'cases': cases, 'holdoutCases': holdout, 'judgeProfile': profile})}
