"""Evidence-bound diagnosis in a fresh read-only OpenJiuwen Agent context."""
from copy import deepcopy
import json

from api.contracts import parse
from agents.criterion import QuietOutput
from agents.model_roles import execute_role
from evaluation.case_generation import json_object
from runtime.models import configured_model_role, model_timeout_ms


def normalized(value):
    value = deepcopy(value)
    if not isinstance(value, dict) or value.get('status') != 'PROPOSED' or not isinstance(value.get('hypothesis'), dict):
        return value
    hypothesis = value['hypothesis']
    confidence = hypothesis.get('confidence')
    if isinstance(confidence, str) and confidence.strip().upper() in ('LOW', 'MEDIUM', 'HIGH'):
        hypothesis['confidence'] = confidence.strip().upper()
    for key in ('requiredCapabilities', 'requiredRuntimeFeatures'):
        if hypothesis.get(key) in (None, [], {}):
            hypothesis.pop(key, None)
    for capability in hypothesis.get('requiredCapabilities', []):
        if not isinstance(capability, dict) or not isinstance(capability.get('constraints'), dict):
            continue
        constraints = capability['constraints']
        effects = constraints.get('sideEffects')
        effects = effects[0] if isinstance(effects, list) and len(effects) == 1 else effects
        if isinstance(effects, str) and effects.strip().lower() in ('none', 'read', 'write'):
            constraints['sideEffects'] = effects.strip().lower()
    return value


async def diagnose(inputs, *, invoke=execute_role):
    role = configured_model_role('OPTIMIZER')
    if not role['configured']:
        raise ValueError('优化模型未配置')
    preview = [{**{key: file[key] for key in ('origin', 'path')}, 'excerpt': file['content'][:2500], 'truncated': len(file['content']) > 2500}
        for file in inputs.get('codeEvidence', [])[:4]]
    payload = {key: value for key, value in inputs.items() if key not in ('codeEvidence', 'runtimeEvidence', 'evaluationEvidence')}
    payload.update(sourcePreview=preview, sourcePreviewOmitted=max(0, len(inputs.get('codeEvidence', [])) - len(preview)))
    original = None
    for attempt in range(2):
        response = await invoke({'role': 'improvement-diagnosis', 'version': 'v1', 'model': role['model'], 'payload': payload,
            'resources': inputs, 'timeoutMs': model_timeout_ms('OPTIMIZER'), 'maxIterations': 8,
            'additionalPrompt': ['诊断只引用开发集证据。区分 Skill、工具、工程、运行配置和评测问题，不把内置 Skill 读取当作待迁移工具。不为了 Runtime 缺少客户端而降级正确的工具形式。']}, QuietOutput())
        try:
            result = normalized(json_object(response['content']))
            if original and original.get('status') == 'PROPOSED' and result.get('status') != 'ABSTAINED' and original != result:
                raise ValueError('纠错结果改变了原始判断或证据')
            result = parse('improvement_judgement', result)
            return {'judgement': result, 'investigation': response.get('investigation', []), 'agentComposition': response.get('receipt')}
        except (ValueError, KeyError, TypeError) as error:
            if attempt:
                raise ValueError('优化规划结果不符合约定：' + str(error)) from None
            try:
                original = normalized(json_object(response['content']))
            except ValueError:
                original = None
            payload = {'validationError': str(error), 'previousResponse': response['content'][:64000],
                'preservedProposal': original, 'instruction': '只修正结构表达，不改变已经给出的层次、假设、证据、风险和验证计划；无法保持时 ABSTAINED。'}
