"""Report data and downloadable formats for the existing comparison UI."""
from functools import lru_cache
import html
import json
import os
import re

from tasks.values import fingerprint, now
from evaluation.judges import criterion_passed


@lru_cache(maxsize=1)
def code_revision():
    try:
        value = json.loads(os.getenv('FINANCE_EVAL_CODE_REVISION_JSON', 'null'))
        if isinstance(value, dict) and re.fullmatch(r'[a-f0-9]{40}', value.get('commit', '')) and value.get('workingTree') in ('clean', 'dirty'):
            return {'commit': value['commit'], 'workingTree': value['workingTree'], 'source': 'server-checkout'}
    except (ValueError, TypeError):
        return None
    return None


def build_report(pack, cases, runtime_id, judge_id, report_id, finalization=None):
    runtime_mode = judge_id.startswith('model-runtime-goals:') or any((case.get('judge') or {}).get('runtimeComparison') for case in cases)
    left_wins = sum((case.get('judge') or {}).get('winner') == 'left' for case in cases) if not runtime_mode else 0
    right_wins = sum((case.get('judge') or {}).get('winner') == 'right' for case in cases) if not runtime_mode else 0
    ties = sum((case.get('judge') or {}).get('winner') == 'tie' for case in cases) if not runtime_mode else 0
    unavailable = len(cases) - left_wins - right_wins - ties
    counts = {}
    if runtime_mode:
        for side in ('left', 'right'):
            count = {'PASS': 0, 'FAIL': 0, 'INDETERMINATE': 0, 'unavailable': 0}
            for case in cases:
                value = (case.get('judge') or {}).get('runtimeComparison', {}).get(side)
                key = value['assessment']['verdict'] if case[side]['status'] == 'completed' and not case.get('judgeError') and value and value['status'] == 'assessed' else 'unavailable'
                count[key] += 1
            counts[side] = count
    if any(case['left']['status'] != 'completed' or case['right']['status'] != 'completed' for case in cases) and not runtime_mode:
        failed = sum(case['left']['status'] != 'completed' or case['right']['status'] != 'completed' for case in cases)
        headline = f'执行未完整完成：{failed}/{len(cases)} 个案例存在执行失败或中断；不能据此判断专业质量'
    elif runtime_mode:
        headline = f"同候选跨 Runtime 目标评估：左侧 {counts['left']['PASS']}/{len(cases)} 条通过，右侧 {counts['right']['PASS']}/{len(cases)} 条通过；左侧 {counts['left']['unavailable']} 条不可用，右侧 {counts['right']['unavailable']} 条不可用"
    elif any((case.get('judge') or {}).get('serviceComparison') or case['left'].get('metadata', {}).get('baselineService') for case in cases):
        headline = f"原服务对比：{sum((case.get('judge') or {}).get('serviceComparison', {}).get('verdict') == 'PASS' for case in cases)}/{len(cases)} 条通过"
    elif pack.get('metadata', {}).get('assessmentMode') == 'natural_language':
        headline = f"业务目标评估：{sum((case.get('judge') or {}).get('goalAssessment', {}).get('verdict') == 'PASS' for case in cases)}/{len(cases)} 条通过"
    elif unavailable == len(cases):
        headline = '左右输出已完成，专业 Judge 暂未形成可用结论'
    elif left_wins == right_wins:
        headline = f'本轮对比持平：左右各胜 {left_wins} 题' + (f'，{ties} 题持平' if ties else '')
    else:
        headline = f'右侧在 {right_wins}/{len(cases)} 个任务中表现更优' if right_wins > left_wins else f'左侧在 {left_wins}/{len(cases)} 个任务中表现更优'
    suggestions = []
    if not runtime_mode:
        for result in cases:
            case = next(item for item in pack['cases'] if item['caseId'] == result['caseId'])
            for criterion in case['rubric']:
                if not (criterion['allOf'] or criterion['anyOf'] or criterion['noneOf']):
                    continue
                left, right = (criterion_passed(criterion, result[side]['output']) for side in ('left', 'right'))
                if not right or not left:
                    suggestions.append({'caseId': case['caseId'], 'criterionId': criterion['criterionId'],
                        'title': ('待改进：' if not right else '已证明增益：') + criterion['label'],
                        'recommendation': criterion.get('improvementHint') or criterion['description'], 'type': 'target_gap' if not right else 'demonstrated_value'})
    def tokens(side):
        return sum(case[side]['usage']['totalTokens'] for case in cases) if cases and all(type((case[side].get('usage') or {}).get('totalTokens')) in (int, float) for case in cases) else None
    summary = {'leftWins': left_wins, 'rightWins': right_wins, 'ties': ties, 'headline': headline,
        'meanElapsedMs': {side: int(sum(case[side]['elapsedMs'] for case in cases) / len(cases) + .5) if cases else 0 for side in ('left', 'right')},
        'totalTokens': {side: tokens(side) for side in ('left', 'right')}, **({'runtimeComparison': counts} if runtime_mode else {})}
    base = {'schemaVersion': 'finance.skill-eval.report.v1', 'reportId': report_id, 'generatedAt': now(), 'codeRevision': code_revision(),
        **({'finalization': finalization} if finalization is not None else {}),
        'pack': {**{key: pack[key] for key in ('packId', 'version', 'domain', 'targetSkillId', 'targetSkillVersion')}, 'fingerprint': pack['packFingerprint']},
        'models': pack['models'], 'variants': pack['variants'], 'runtimeAdapterId': runtime_id, 'judgeId': judge_id,
        'engine': {'name': 'finance-python-evaluation', 'version': '1', 'completed': True},
        'cases': cases, 'summary': summary, 'suggestions': suggestions}
    return {**base, 'reportFingerprint': fingerprint(base)}


def markdown_report(report):
    lines = ['# ' + report['pack']['targetSkillId'] + ' Skill 评测报告', '', '- 结论：' + report['summary']['headline'],
        '- Eval Pack：' + report['pack']['packId'] + '@' + report['pack']['version'], '- Runtime：' + report['runtimeAdapterId'],
        '- Judge：' + report['judgeId'], '- 报告指纹：' + report['reportFingerprint'], '']
    for index, case in enumerate(report['cases']):
        judgement = case.get('judge') or {}
        lines.extend([f"## {index + 1}. {case['name']}", '', '**任务：** ' + case['prompt'], '',
            judgement.get('summary') or case.get('judgeError') or '无评价', '', '### 左侧输出', '', case['left']['output'], '', '### 右侧输出', '', case['right']['output'], ''])
    return '\n'.join(lines)


def html_report(report):
    escape = lambda value: html.escape(str(value))
    cards = []
    for index, case in enumerate(report['cases']):
        outputs = ''.join('<section><h3>' + label + '</h3><pre>' + escape(case[side]['output']) + '</pre></section>'
            for side, label in [('left', '左侧输出'), ('right', '右侧输出')])
        judge = case.get('judge') or {}
        cards.append('<article><h2>' + escape(f"{index + 1}. {case['name']}") + '</h2><p>' + escape(case['prompt']) +
            '</p><div class="outputs">' + outputs + '</div><aside>' + escape(judge.get('summary') or case.get('judgeError') or '无评价') + '</aside></article>')
    return ('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src &#39;unsafe-inline&#39;">'
        '<title>Skill 评测报告</title><style>body{font:15px/1.65 system-ui;background:#f4f6fa;color:#233;max-width:1200px;margin:40px auto;padding:20px}'
        'article,header{background:white;padding:24px;border:1px solid #e2e6ed;border-radius:12px;margin-bottom:20px}'
        '.outputs{display:grid;grid-template-columns:1fr 1fr;gap:20px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;background:#f7f9fc;padding:16px;border-radius:8px}'
        'aside{padding:16px;border-left:3px solid #506ee5}small{overflow-wrap:anywhere}@media(max-width:700px){.outputs{grid-template-columns:1fr}}</style></head><body><header><h1>' +
        escape(report['pack']['targetSkillId']) + ' Skill 评测报告</h1><p>' + escape(report['summary']['headline']) + '</p><small>Runtime：' +
        escape(report['runtimeAdapterId']) + '<br>Judge：' + escape(report['judgeId']) + '<br>报告指纹：' + escape(report['reportFingerprint']) +
        '</small></header>' + ''.join(cards) + '</body></html>')
