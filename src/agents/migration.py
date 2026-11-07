"""Main engineering Agent adapter, invoked through Jiuwen Runtime sessions."""
import json
import os
from pathlib import Path

from api.contracts import parse
from runtime.agent_client import AgentRuntimeClient
from runtime.models import model_timeout_ms
from migration.state import MigrationControlError


async def run_migration(inputs, correlation, *, runtime=None, on_activity=None, on_composition=None):
    if inputs['mode'] != 'CHAT':
        raise MigrationControlError('迁移操作请通过主 Agent 会话发起')
    runtime = runtime or AgentRuntimeClient()
    version = inputs.get('roleVersion') or os.getenv('FINANCE_EVAL_AGENT_ROLE_VERSION', 'v1')
    guide = json.loads((Path(__file__).parents[2] / 'contracts/platform/migration-guidance.json').read_text(encoding='utf-8'))
    bundle = {'mode': 'CHAT', 'validateResult': True, 'source': inputs['source'],
        'base': {'digest': inputs['base']['digest'], 'members': inputs['base']['members']}, 'goal': inputs['goal'],
        'target': inputs['target'], 'standardizationGuide': guide,
        **{key: inputs[key] for key in ('project', 'adjustmentCapabilities', 'analysis', 'clarification', 'agentFollowup',
            'agentCanReview', 'reviewAvailable', 'agentOptimization', 'budgetContinuation', 'evaluationAvailability',
            'runtimePreparation', 'resumeDraftAttemptIds', 'feedback') if key in inputs}}
    body = {'stage': 'migration', 'agentRoleVersion': version,
        'model': {'modelId': os.getenv('FINANCE_EVAL_AGENT_MODEL_ID', 'enterprise-model'), 'providerId': 'service-execution'},
        'maxIterations': max(1, int(os.getenv('FINANCE_EVAL_AGENT_MAX_ITERATIONS', '120'))),
        'maxTokens': max(1, int(os.getenv('FINANCE_EVAL_MIGRATION_MAX_TOKENS', os.getenv('FINANCE_EVAL_AGENT_MAX_TOKENS', '32000')))),
        'modelTimeoutMs': model_timeout_ms('MIGRATION'), 'assetDigest': inputs['base']['digest'],
        'runId': correlation['agentRunId'], 'correlation': correlation, 'checkpointRoot': inputs['checkpointRoot'],
        'taskSession': inputs.get('taskSession', {}), 'files': inputs['base']['files'], 'bundle': bundle}
    # The Runtime owns instance scheduling and durable execution replay. No
    # subprocess per request or local fallback Agent is started here.
    # A live engineering conversation can include many bounded model/tool
    # operations. A wall clock on this HTTP subscription would abort healthy
    # work independently of the Agent's iteration budget and user controls.
    wire = await runtime.execute(body, correlation['taskId'], on_activity=on_activity)
    if not isinstance(wire, dict):
        raise MigrationControlError('Agent 运行服务没有返回有效结果')
    if on_composition and wire.get('composition'):
        await on_composition(wire['composition'])
    payload = wire.get('payload') or {}
    if wire.get('status') == 'WAITING':
        return {'status': 'WAITING', 'interactions': payload.get('interactions', [])}
    if wire.get('status') == 'ABSTAINED':
        return {'status': 'ABSTAINED', 'reason': payload.get('reason') or '需要补充迁移信息'}
    if wire.get('status') != 'PRODUCED':
        raise MigrationControlError(wire.get('error') or '整组迁移 Agent 未完成')
    if not isinstance(payload.get('message'), str) or not payload['message'].strip():
        raise MigrationControlError('Agent 没有返回有效回答')
    result = {'status': 'PRODUCED', 'message': payload['message'].strip(), 'files': wire.get('files'),
        'executions': [parse('project_execution', item) for item in payload.get('executions', [])],
        'deliveryReviews': [parse('delivery_review', item) for item in payload.get('deliveryReviews', [])],
        'evaluationRequested': payload.get('evaluationRequested') is True}
    if len(result['deliveryReviews']) > 20:
        raise MigrationControlError('独立审查记录过多')
    if payload.get('deliveryTools'):
        value = payload['deliveryTools']
        # Reuse the delivery schema projection; no generated files are inferred.
        result['deliveryTools'] = {'services': value.get('services', []), 'tools': value.get('tools', [])}
    for key in ('runtimePreparationRequested', 'budgetRequest', 'reviewRequested', 'optimizationRequest'):
        if payload.get(key):
            result[key] = payload[key]
    if result.get('budgetRequest') and result['budgetRequest'].get('attemptId') != correlation['attemptId']:
        raise MigrationControlError('预算请求不属于当前会话')
    if result.get('optimizationRequest'):
        result['optimizationRequest']['goal'] = parse('optimization_goal', result['optimizationRequest']['goal'])
    return result
