"""Publish reviewable development-case suggestions, never mutate a test suite."""
from uuid import uuid4

from openjiuwen.core.foundation.tool import LocalFunction, ToolCard


def build_case_proposal_tool(conversation, session_id, attempt_id, redact):
    async def propose_development_cases(name, cases, coverage):
        if not isinstance(name, str) or not name.strip() or len(name) > 200:
            return {'accepted': False, 'reason': '请提供不超过 200 字的建议名称'}
        if not isinstance(coverage, str) or not coverage.strip() or len(coverage) > 5000:
            return {'accepted': False, 'reason': '请说明覆盖范围和待核实条件'}
        if not isinstance(cases, list) or not 1 <= len(cases) <= 8:
            return {'accepted': False, 'reason': '请提供 1 至 8 个开发案例'}
        normalized = []
        for item in cases:
            if not isinstance(item, dict):
                return {'accepted': False, 'reason': '案例需要任务内容和判断标准'}
            question, criteria, rationale = item.get('input'), item.get('criteria'), item.get('rationale', '')
            if not isinstance(question, str) or not question.strip() or len(question) > 12000:
                return {'accepted': False, 'reason': '案例任务内容不能为空，且不超过 12000 字'}
            if not isinstance(criteria, list) or not 1 <= len(criteria) <= 20 or any(
                not isinstance(value, str) or not value.strip() or len(value) > 2000 for value in criteria
            ):
                return {'accepted': False, 'reason': '每个案例需要 1 至 20 条非空判断标准'}
            if not isinstance(rationale, str) or len(rationale) > 2000:
                return {'accepted': False, 'reason': '案例设计说明不能超过 2000 字'}
            normalized.append({'input': redact(question.strip()), 'criteria': [redact(value.strip()) for value in criteria],
                               **({'rationale': redact(rationale.strip())} if rationale.strip() else {})})
        sequence = await conversation.append(session_id, 'case-proposal:' + uuid4().hex, 'case_proposal', {
            'name': redact(name.strip()), 'coverage': redact(coverage.strip()), 'cases': normalized, 'attemptId': attempt_id})
        return {'accepted': True, 'sequence': sequence,
                'note': '已提出开发案例供用户审阅；未更改测试集、未设置留出集，也未运行评测。'}

    return LocalFunction(ToolCard(id='migration-propose-development-cases', name='propose_development_cases',
        description='用户要求设计效果测试时，提交少量开发案例供用户审阅。描述覆盖范围与未知条件；不编造业务事实或标准答案，不声明案例只读，不创建留出集。此工具不会修改测试集或运行评测。',
        input_params={'type': 'object', 'properties': {
            'name': {'type': 'string'}, 'coverage': {'type': 'string'},
            'cases': {'type': 'array', 'items': {'type': 'object', 'properties': {
                'input': {'type': 'string'}, 'criteria': {'type': 'array', 'items': {'type': 'string'}},
                'rationale': {'type': 'string'}}, 'required': ['input', 'criteria']}}},
            'required': ['name', 'coverage', 'cases']}), propose_development_cases)
