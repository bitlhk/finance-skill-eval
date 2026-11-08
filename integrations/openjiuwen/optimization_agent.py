"""OpenJiuwen optimization coordinator; business operations remain explicit ports."""
import asyncio
import json
import logging
import os
import re
from pathlib import Path
import sys
import tempfile
import uuid

try:
    from .agent_protocol import emit
    from .optimization_coordinator import OptimizationCoordinator, evaluation_summary, now
except ImportError:
    from agent_protocol import emit
    from optimization_coordinator import OptimizationCoordinator, evaluation_summary, now


def recover_explicit_tool(response):
    """Recover an explicit, argument-free tool call truncated by a model gateway."""
    if getattr(response, 'finish_reason', None) != 'length' or getattr(response, 'tool_calls', None):
        return None
    content = getattr(response, 'content', None)
    if not isinstance(content, str):
        return None
    matches = re.findall(r'<tool_call>\s*<function=(diagnose_optimization|adjust_candidate|build_runtime|evaluate_candidate|review_candidate)\s*>', content)
    return matches[0] if len(matches) == 1 and content.count('<tool_call>') == 1 and content.count('<function=') == 1 else None


def optimizer_binding():
    from runtime.models import agent_role_binding
    binding, model = agent_role_binding('OPTIMIZER')
    return binding, model['modelId']

async def run(body, output, *, invoke):
    from runtime.models import model_timeout_ms
    from types import SimpleNamespace
    bridge = SimpleNamespace(invoke=invoke)
    coordinator = OptimizationCoordinator(body['state'], body['baseline'], bridge.invoke, body.get('resume'), body.get('buildAvailable', False))
    from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
    from openjiuwen.core.single_agent.rail.base import AgentRail
    from openjiuwen.core.sys_operation import SysOperation
    from openjiuwen.core.sys_operation.base import OperationMode
    from openjiuwen.core.sys_operation.config import LocalWorkConfig
    from openjiuwen.core.sys_operation.sys_operation import SysOperationCard
    try:
        from .agent_execution import assemble_agent
        from .agent_roles import load_role
        from .model_config import request_settings
    except ImportError:
        from agent_execution import assemble_agent
        from agent_roles import load_role
        from model_config import request_settings

    try:
        await coordinator.initialize()
        composition = load_role('optimization-coordinator', body.get('agentRoleVersion', 'v1'))
        bound, model_id = optimizer_binding()
        run_body = {'files': {}, 'model': {'modelId': model_id, 'providerId': 'service-optimizer'},
                    'inputDigestMaterial': {'goal': body['state']['goal'], 'baseline': body['baseline'], 'resume': body.get('resume')},
                    'maxIterations': min(80, 12 * body['state']['goal']['maxRounds'] + 8),
                    'maxTokens': body.get('maxTokens', int(os.environ.get('FINANCE_EVAL_OPTIMIZATION_AGENT_MAX_TOKENS', '2048'))),
                    'modelTimeoutMs': body.get('modelTimeoutMs', model_timeout_ms('OPTIMIZER'))}
        tool_lock = asyncio.Lock()
        def serialized(function):
            async def call():
                async with tool_lock:
                    return await function()
            return call
        tools = []
        for name, description, function in [
            ('diagnose_optimization', '根据当前评测证据诊断缺陷，决定需要调整的 Skill、工具或 Runtime。', coordinator.diagnose),
            ('adjust_candidate', '依据诊断调用调整能力，生成候选；外部依赖不可用时返回等待。', coordinator.adjust),
            ('build_runtime', '需要 Builder 改造 Runtime 时构建并验证交付，然后继续本轮评测。', coordinator.build_runtime),
            ('evaluate_candidate', '通过统一评测运行当前候选并收集证据。', coordinator.evaluate),
            ('review_candidate', '请求独立 Review 结合目标判断改进和回退。', coordinator.review),
        ]:
            tools.append(LocalFunction(ToolCard(id='optimization-' + name, name=name, description=description,
                parallel_safe=False, idempotent=False, properties={'resilience': {'timeout_s': None}},
                input_params={'type': 'object', 'properties': {}}), serialized(function)))

        async def finish_optimization(reason=''):
            async with tool_lock:
                return await coordinator.finish(reason.strip() or None)

        tools.append(LocalFunction(ToolCard(id='optimization-finish', name='finish_optimization',
            description='结束优化并保留已审查的推荐版本；reason 简述结束原因。',
            input_params={'type': 'object', 'properties': {'reason': {'type': 'string'}}}), finish_optimization))

        class FinishRail(AgentRail):
            last_finish_reason = None
            explicit_tool = None
            async def before_model_call(self, ctx):
                if coordinator.terminal:
                    ctx.request_force_finish({'output': '优化阶段已结束', 'result_type': 'answer'})
            async def after_model_call(self, ctx):
                self.last_finish_reason = getattr(ctx.inputs.response, 'finish_reason', None)
                self.explicit_tool = recover_explicit_tool(ctx.inputs.response)
            async def after_tool_call(self, ctx):
                if coordinator.terminal:
                    ctx.request_force_finish({'output': '优化阶段已结束', 'result_type': 'answer'})

        with tempfile.TemporaryDirectory(prefix='finance-optimization-agent-') as workspace:
            operation = SysOperation(SysOperationCard(id='optimization-coordinator', mode=OperationMode.LOCAL,
                work_config=LocalWorkConfig(restrict_to_sandbox=True, sandbox_root=[workspace], shell_allowlist=[])))
            finish_rail = FinishRail()
            agent, model, activity, receipt = assemble_agent(composition=composition, body=run_body,
                bound=bound, settings=request_settings(bound, model_id), workspace=Path(workspace), operation=operation,
                tools=tools, protocol=output, trace=[], kind='deep', extra_rails=[finish_rail])
            coordinator.state['coordinatorComposition'] = receipt
            await coordinator.save()
            interruptions = 0
            for attempt in range(min(30, 8 * body['state']['goal']['maxRounds'] + 8)):
                previous = (coordinator.phase, len(coordinator.state['rounds']))
                query = json.dumps({'goal': body['state']['goal'], 'baseline': evaluation_summary(body['baseline']),
                                    'resume': bool(body.get('resume')) or attempt > 0,
                                    'currentPhase': coordinator.phase, 'currentRound': coordinator.round,
                                    'working': evaluation_summary(coordinator.working)}, ensure_ascii=False)
                finish_rail.last_finish_reason = None
                finish_rail.explicit_tool = None
                result = await agent.invoke({'query': '根据目标和已有证据推进优化；如果正在恢复，请从当前阶段继续。当前材料：' + query})
                if isinstance(result, dict) and result.get('result_type') == 'error':
                    raise RuntimeError(str(result.get('output') or 'Optimization agent failed'))
                if coordinator.terminal:
                    break
                if finish_rail.explicit_tool:
                    selected = finish_rail.explicit_tool
                    capability = {'diagnose_optimization': coordinator.diagnose, 'adjust_candidate': coordinator.adjust, 'build_runtime': coordinator.build_runtime,
                                  'evaluate_candidate': coordinator.evaluate, 'review_candidate': coordinator.review}[selected]
                    activity.send('tool_start', '恢复工具调用：' + selected)
                    async with tool_lock:
                        recovered = await capability()
                    activity.send('tool_end' if recovered.get('accepted', True) else 'tool_error', '恢复工具结束：' + selected)
                    if coordinator.terminal:
                        break
                if finish_rail.last_finish_reason != 'length' and coordinator.phase == 'DIAGNOSIS':
                    break
                current = (coordinator.phase, len(coordinator.state['rounds']))
                interruptions = interruptions + 1 if current == previous else 0
                if interruptions >= 3:
                    raise RuntimeError('Agent 多次中断，已保存当前诊断和候选，修复模型后可继续')
            else:
                raise RuntimeError('Agent 超过调用预算，已保存当前诊断和候选')
        if not coordinator.terminal:
            await coordinator.finish('Agent 已结束本轮工作，保留已审查的推荐版本')
    except Exception as error:
        if coordinator.state.get('status') != 'WAITING':
            reason = str(error) or ('优化协调 Agent 模型调用超时，请检查模型服务后接续已有候选' if isinstance(error, TimeoutError) else type(error).__name__)
            for key in ('FINANCE_EVAL_OPTIMIZER_API_KEY', 'FINANCE_EVAL_MODEL_API_KEY',
                        'FINANCE_EVAL_OPTIMIZER_BASE_URL', 'FINANCE_EVAL_MODEL_BASE_URL'):
                secret = os.environ.get(key, '')
                if secret:
                    reason = reason.replace(secret, '[redacted]')
            coordinator.state.update(status='FAILED', reason=reason[:2000], finishedAt=now())
            try:
                await bridge.invoke('activate', {'evaluation': coordinator.best})
                await coordinator.save()
            except Exception:
                pass
    emit(output, {'type': 'result', 'state': coordinator.state})
    return coordinator.state
