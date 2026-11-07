"""Read existing development evaluations without treating stale runs as current."""
from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
from agents.evidence_query import query_evidence


def build_evaluation_evidence_tool(evaluations, current_digest):
    records = [item for item in evaluations if isinstance(item, dict)] if isinstance(evaluations, list) else []

    async def query_development_evaluations(run_id='', path=None, operation='read', offset=0, limit=6000):
        digest = current_digest()
        def summary(record):
            return {key: record.get(key) for key in ('runId', 'candidateId', 'candidateDigest', 'status', 'effectStatus', 'matchesCurrentConfiguration')} | {
                'matchesCurrentWorkspace': record.get('status') != 'UNAVAILABLE' and record.get('candidateDigest') == digest}
        if not run_id:
            return {'evaluations': [summary(item) for item in records], 'currentDigest': digest,
                    'note': '仅包含开发集；评测只适用于其记录的文件及运行、测试集和评判配置。'}
        record = next((item for item in records if item.get('runId') == run_id), None)
        if record is None:
            return {'found': False, 'reason': '没有这个开发集评测记录'}
        if path is not None:
            return {'found': True, **summary(record), 'currentDigest': digest,
                'query': query_evidence(record, path, operation or 'read', offset or 0, 6000 if limit is None else limit),
                'note': '冻结开发集材料的分段查询；文件或配置不一致时只可作为历史证据。'}
        overview = {key: value for key, value in record.items() if key not in ('evaluationEvidence', 'reviews')}
        return {'found': True, **overview, **summary(record), 'currentDigest': digest,
                'detailAvailable': 'evaluationEvidence' in record,
                'detailQuery': {'path': '/evaluationEvidence', 'operation': 'list'},
                'note': '文件不一致时只能作为历史证据，不能用于证明当前文件通过。'}

    return LocalFunction(ToolCard(id='migration-development-evidence', name='query_development_evaluations',
        description='不填 run_id 列出开发运行；填 run_id 默认返回全部案例的简短结论。读取原始详情时增加 path(JSON pointer)、operation(read/list)、offset、limit 分段查询，例如 path=/evaluationEvidence/current，operation=list。每次核对工作文件版本；不包含留出集，不运行评测。',
        input_params={'type': 'object', 'properties': {'run_id': {'type': 'string'}, 'path': {'type': 'string'},
            'operation': {'type': 'string', 'enum': ['read', 'list']}, 'offset': {'type': 'integer', 'minimum': 0},
            'limit': {'type': 'integer', 'minimum': 1, 'maximum': 12000}}}), query_development_evaluations)
