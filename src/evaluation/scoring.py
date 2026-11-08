"""Live comparison and offline rescoring use this same frozen-evidence scoring."""
from copy import deepcopy
from agents.criterion import judge_criteria
from evaluation.checks import execution_checks
from evaluation.comparison import evaluate
from evaluation.orchestration import planned_methods
from evaluation.scripts import verify_script
from runtime.models import model_timeout_ms


async def evaluate_comparison(case, left, right, judge, profile, presentation_order=None):
    methods = planned_methods(case.get('evaluationPlan'), verify_script)
    execution = [criterion for criterion in case['rubric'] if criterion.get('scope') == 'execution']
    if execution and not judge.independent:
        async def assess(inputs):
            evidence = inputs['evidence']
            if evidence.get('status') != 'completed' or evidence.get('runtimeIdentityVerified') is not True or evidence.get('streamCompleted') is not True:
                return [{'id': criterion['criterionId'], 'status': 'UNVERIFIED',
                    'reason': '执行或身份验证未完整完成，未调用过程 Judge；请先修复运行错误。'} for criterion in execution]
            if getattr(judge, 'mode', None) != 'pairwise':
                return [{'id': criterion['criterionId'], 'status': 'UNVERIFIED', 'reason': '当前评判器未提供执行标准评判；答案质量分不能替代过程验证'} for criterion in execution]
            verdict = await judge_criteria({'evalCase': {**case, 'rubric': execution}, 'evidence': inputs['evidence']}, model=judge.model)
            result = []
            for criterion in execution:
                checked = next((item for item in verdict.get('criteria', []) if item['id'] == criterion['criterionId']), {})
                result.append({'id': criterion['criterionId'], 'status': 'PASS' if checked.get('passed') is True else 'FAIL' if checked.get('passed') is False else 'UNVERIFIED',
                    'reason': checked.get('reason', '缺少此执行标准的判断'), 'evidenceRefs': checked.get('evidenceRefs', [])})
            return result
        methods.append({'id': 'execution-criteria', 'version': judge.judge_id, 'kind': 'MODEL', 'timeoutMs': model_timeout_ms('JUDGE'), 'evaluate': assess})
    if case.get('stateFixture'):
        async def state(inputs):
            checks = [item for item in execution_checks(inputs['evidence']) if item['id'] == 'execution.business-state']
            return checks or [{'id': 'execution.business-state', 'status': 'UNVERIFIED', 'reason': '缺少业务状态回执'}]
        methods.insert(0, {'id': 'business-state', 'version': '1', 'kind': 'RULE', 'evaluate': state})
    async def compare(inputs):
        return await judge.compare(inputs['evalCase'], inputs['left'], inputs['right'], deepcopy(profile), presentation_order)
    return await evaluate(case, left, right, compare, independent=judge.independent, methods=methods)


async def judge_for(configuration, pack, workspace):
    from assets.library import AssetLibrary
    from runtime.models import configured_model_role
    from evaluation.judges import DeterministicJudge, ModelJudge
    if configuration['judgeMode'] == 'deterministic':
        if any(not criterion['allOf'] and not criterion['anyOf'] and not criterion['noneOf'] for case in pack['cases'] for criterion in case['rubric']):
            raise ValueError('当前专业量表需使用模型 Judge，不支持空规则自动评分。')
        return DeterministicJudge()
    role = configured_model_role('JUDGE')
    if not role['configured']:
        raise ValueError('本服务未配置阅卷模型')
    mode = configuration['evaluationMode']
    selected = 'runtime' if mode == 'candidate_runtime_comparison' else 'service' if mode == 'service_comparison' else (
        'goal' if pack.get('metadata', {}).get('assessmentMode') == 'natural_language' else 'candidate') if mode == 'candidate_assessment' else 'pairwise'
    library, skills = AssetLibrary(workspace), {}
    if selected in ('runtime', 'goal'):
        for side in ('left', 'right') if selected == 'runtime' else ('right',):
            binding = (configuration.get('runtimeBindings') or {}).get(side)
            source = await library.resolve(pack['variants'][side], binding['skillAssetId'] if binding else configuration.get('skillAssetId'))
            if source:
                prefix = source['skillFile'][:-len('SKILL.md')]
                skills[side] = {key: source[key] for key in ('skillId', 'version', 'artifactSha256', 'instructions')}
                skills[side]['skillPackage'] = {'artifactSha256': source['artifactSha256'], 'files': {
                    name[len(prefix):]: content for name, content in source['files'].items() if name.startswith(prefix)}}
    return ModelJudge(selected, configuration.get('judgeModel') or pack['models']['judge'], adapter=role['adapter'], skills=skills,
        tools=(configuration.get('runtimeCommandBindings') or {}).get('right', []))
