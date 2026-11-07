"""Independent effect Review through the shared Jiuwen Runtime."""
import json
import os
from uuid import uuid4
from agents.effect_review import assess
from runtime.agent_client import AgentRuntimeClient
from runtime.models import configured_model_role, model_timeout_ms


async def review(material, identifier, attempt_id, root, *, runtime=None, on_activity=None):
    role = configured_model_role('JUDGE')
    if not role['configured']:
        raise ValueError('独立审查 Agent 尚未配置')
    body = {'taskSession': {'executionId': str(uuid4())},
        'correlation': {'taskId': identifier, 'attemptId': attempt_id}, 'checkpointRoot': str(root),
        'roleCall': {'role': 'effect-review', 'version': os.getenv('FINANCE_EVAL_AGENT_ROLE_VERSION', 'v1'),
            'payload': material, 'resources': material, 'model': role['model'],
            'timeoutMs': model_timeout_ms('JUDGE'), 'maxIterations': 1}}
    response = await (runtime or AgentRuntimeClient()).execute(body, identifier, on_activity=on_activity)
    if not isinstance(response, dict) or not isinstance(response.get('content'), str):
        raise ValueError('独立审查没有返回结果')
    return assess(material, json.loads(response['content']))
