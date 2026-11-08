"""Single assembly boundary for platform engineering agents.

Callers supply task-specific tools and workspace boundaries; this module owns model
configuration, tracing, SDK defaults and execution. Business Runtime skill loading
is deliberately outside this platform-agent boundary.
"""

import asyncio
import hashlib
import json
from pathlib import Path


def bind_model_deadline(model, timeout_seconds):
    """Bound the whole model call, including a stream that never becomes idle."""
    invoke = getattr(model, 'invoke', None)
    stream = getattr(model, 'stream', None)
    if callable(invoke):
        async def timed_invoke(*args, **kwargs):
            async with asyncio.timeout(timeout_seconds):
                return await invoke(*args, **kwargs)
        model.invoke = timed_invoke
    if callable(stream):
        async def timed_stream(*args, **kwargs):
            async with asyncio.timeout(timeout_seconds):
                async for chunk in stream(*args, **kwargs):
                    yield chunk
        model.stream = timed_stream
    return model


def assemble_agent(*, composition, body, bound, settings, workspace, operation,
                   tools, protocol, trace, kind, max_iterations=120, timeout_ms=300000,
                   prompt_suffix='', extra_rails=(), task_session=None, session_tools=()):
    from openjiuwen.harness.factory import create_deep_agent
    from openjiuwen.harness.subagents.explore_agent import create_explore_agent
    try:
        from .model_config import create_model
        from .agent_activity import ActivityRail
        from .harness_tools import ToolTraceRail, FilesystemOnlyRail
    except ImportError:
        from model_config import create_model
        from agent_activity import ActivityRail
        from harness_tools import ToolTraceRail, FilesystemOnlyRail

    names = [tool.card.name for tool in tools]
    composition.validate_tools(names)
    if session_tools and task_session is None:
        raise ValueError('Session tools require a persistent task session')
    session_names = [tool.card.name for tool in session_tools]
    if len(set(names + session_names)) != len(names) + len(session_names):
        raise ValueError('Duplicate Agent tool name')
    model = create_model(bound, settings, role=composition.definition['modelRole'],
                         temperature=float(body.get('temperature', settings.get('temperature', bound.get('temperature', 0.2)))),
                         max_tokens=int(body.get('maxTokens', 32000)),
                         timeout_ms=int(body.get('modelTimeoutMs', timeout_ms)))
    activity = ActivityRail(protocol, [bound.get('apiKey', ''), bound.get('baseUrl', '')])
    main_prompt_path = None
    if task_session is not None:
        main_prompt_path = Path(__file__).resolve().parents[2] / 'src/resources/agents/v1/prompts/migration-main.md'
        prompt = '\n\n'.join([main_prompt_path.read_text(encoding='utf-8'), prompt_suffix])
    else:
        prompt = '\n\n'.join([composition.prompt, composition.guidance, composition.contract, prompt_suffix])
    prompt = prompt.replace('@@WORKSPACE_ROOT@@', str(workspace))
    factory = {'explore': create_explore_agent, 'deep': create_deep_agent}[kind]
    session_kwargs = {}
    session_rails = []
    if task_session is not None:
        if kind != 'deep':
            raise ValueError('The task session requires a DeepAgent')
        from uuid import uuid4
        from openjiuwen.harness.rails.interrupt.ask_user_rail import AskUserRail
        from openjiuwen.harness.rails.skills.skill_use_rail import SkillUseRail
        try:
            from .context_archive_guard import TaskContextProcessorRail
        except ImportError:
            from context_archive_guard import TaskContextProcessorRail
        from openjiuwen.core.context_engine.schema.config import ContextEngineConfig, CompressionRecallConfig
        from openjiuwen.core.single_agent.schema.agent_card import AgentCard
        from openjiuwen.harness.schema.config import SubAgentConfig
        from openjiuwen.harness.workspace.workspace import Workspace
        try:
            from .agent_session import task_agent_card
        except ImportError:
            from agent_session import task_agent_card
        roots = task_session.get('skill_roots')
        if not isinstance(roots, (list, tuple)) or not roots or any(not isinstance(root, str) or not root for root in roots):
            raise ValueError('The task session requires trusted skill roots')
        window = bound.get('contextWindowTokens')
        if window is not None and (isinstance(window, bool) or not isinstance(window, int) or window <= 0):
            raise ValueError('contextWindowTokens must be a positive integer')
        session_rails = [AskUserRail(), SkillUseRail(skills_dir=list(roots), skill_mode='auto_list', include_tools=False),
                         TaskContextProcessorRail(preset=True, processors=[('SessionMemoryCompressor', {'enabled': True})])]
        # Subagents receive a new framework session and only explicit task
        # materials. Their file tools are restricted to the existing sandbox;
        # no editing, execution, submission or approval tools are inherited.
        read_tools = [tool for tool in tools if tool.card.name in {'read_file', 'glob', 'list_files', 'grep'}]
        development_evidence_tools = [tool for tool in session_tools if tool.card.name == 'query_development_evaluations']
        from runtime.models import configured_model_role, agent_role_binding, model_timeout_ms
        review_model = model
        review_secrets = [bound.get('apiKey', ''), bound.get('baseUrl', '')]
        if configured_model_role('JUDGE')['configured']:
            review_binding, review_reference = agent_role_binding('JUDGE')
            review_secrets.extend(review_binding.get(key, '') for key in ('apiKey', 'baseUrl'))
            # Independent delivery review follows the configured reviewer role,
            # rather than silently inheriting the engineering model. Like the
            # other Review adapter it uses complete SDK model responses.
            review_model = create_model({**review_binding, 'supportsStreaming': False},
                {'model_name': review_reference['modelId']}, role='JUDGE',
                timeout_ms=model_timeout_ms('JUDGE'), max_tokens=8000,
                defaults=review_binding.get('requestDefaults', {}))
        class DeliveryReviewActivity(ActivityRail):
            def send(self, kind, label, text=None):
                super().send(kind, '交付审查 · ' + label, text)
        prompts = Path(__file__).resolve().parents[2] / 'src/resources/agents/v1/prompts'
        subagents = [SubAgentConfig(agent_card=AgentCard(name=name, description=description),
                      system_prompt=(prompts / filename).read_text(encoding='utf-8'),
                      tools=(read_tools + development_evidence_tools if name == 'migration_delivery_reviewer'
                             else read_tools if name == 'migration_investigator' else []),
                      model=review_model if name == 'migration_delivery_reviewer' else model,
                      rails=([DeliveryReviewActivity(protocol, review_secrets)]
                                          if name == 'migration_delivery_reviewer' else []) + [FilesystemOnlyRail()],
                      workspace=Workspace(root_path=str(workspace)),
                      sys_operation=operation, language='cn', prompt_mode='minimal',
                      enable_read_image_multimodal=False, factory_kwargs={'auto_create_workspace': False})
                     for name, description, filename in [
                         ('migration_investigator', '只读调查复杂问题及证据，提出可验证假设', 'migration-investigation.md'),
                         ('migration_delivery_reviewer', '独立只读核查迁移交付、源码和验证缺口', 'migration-delivery-review.md'),
                         ('review_advisor', '只读分析候选效果和证据，提出审查建议', 'migration-review-advice.md')]]
        session_kwargs = {'card': task_agent_card(), 'tool_owner_id': 'migration-instance-' + uuid4().hex,
                          'enable_task_planning': True, 'subagents': subagents,
                          'context_engine_config': ContextEngineConfig(model_name=settings['model_name'],
                              context_window_tokens=window, enable_reload=True,
                              compression_recall_config=CompressionRecallConfig(enabled=True))}
    agent_kwargs = dict(system_prompt=prompt, tools=[*tools, *session_tools], sys_operation=operation,
                        workspace=str(workspace), max_iterations=int(body.get('maxIterations', max_iterations)),
                        language='cn', rails=[activity, ToolTraceRail(trace), *extra_rails, *session_rails, FilesystemOnlyRail()],
                        prompt_mode='minimal', auto_create_workspace=False, enable_task_loop=False,
                        enable_read_image_multimodal=False, **session_kwargs)
    if task_session is not None:
        from openjiuwen.harness.factory import resolve_deep_agent_parts
        from openjiuwen.agent_teams.harness.native_harness import NativeHarness
        class TaskSpec:
            def resolve_parts(self, _context):
                return resolve_deep_agent_parts(model, **agent_kwargs)
        agent = NativeHarness(TaskSpec())
    else:
        agent = factory(model=model, **agent_kwargs)
    receipt_body = {**body, 'maxIterations': body.get('maxIterations', max_iterations),
                    'modelTimeoutMs': body.get('modelTimeoutMs', timeout_ms)}
    receipt = composition.receipt(receipt_body, bound, names + session_names)
    if main_prompt_path is not None:
        resource = {'path': 'prompts/migration-main.md',
                    'sha256': hashlib.sha256(main_prompt_path.read_bytes()).hexdigest()}
        subagent_resources = [{'path': 'prompts/' + filename,
                               'sha256': hashlib.sha256((main_prompt_path.parent / filename).read_bytes()).hexdigest()}
                              for filename in ('migration-investigation.md', 'migration-delivery-review.md', 'migration-review-advice.md')]
        receipt['resources'] = [*receipt.get('resources', []), resource, *subagent_resources]
        receipt['definitionDigest'] = hashlib.sha256(json.dumps({
            'base': receipt.get('definitionDigest'), 'mainPrompt': resource, 'subagentPrompts': subagent_resources,
        }, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return agent, model, activity, receipt
