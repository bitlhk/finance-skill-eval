"""Independent effect reviewer built with OpenJiuwen's subagent facility."""
import json
from uuid import uuid4


def effect_reviewer_config(model, prompt, workspace, operation, extra_rails=()):
    """Create a reviewer with no access to the parent's tools or conversation."""
    from openjiuwen.core.single_agent.schema.agent_card import AgentCard
    from openjiuwen.harness.schema.config import SubAgentConfig
    from openjiuwen.harness.workspace.workspace import Workspace
    try:
        from .harness_tools import FilesystemOnlyRail
    except ImportError:
        from harness_tools import FilesystemOnlyRail

    return SubAgentConfig(
        agent_card=AgentCard(name='effect_reviewer', description='独立审查冻结评测证据'),
        system_prompt=prompt, model=model, tools=[], rails=[*extra_rails, FilesystemOnlyRail()],
        workspace=Workspace(root_path=str(workspace)), sys_operation=operation,
        language='cn', prompt_mode='minimal', max_iterations=1,
        enable_read_image_multimodal=False, factory_kwargs={'auto_create_workspace': False})


async def run_effect_review_subagent(parent, model, prompt, evidence, workspace, operation, extra_rails=()):
    """Review only the supplied frozen evidence; never inherit editing tools."""
    from openjiuwen.core.session.agent import create_agent_session
    from openjiuwen.harness.tools.subagent.task_tool import create_task_tool

    original = parent.deep_config.subagents
    parent.deep_config.subagents = [effect_reviewer_config(model, prompt, workspace, operation, extra_rails)]
    try:
        session = create_agent_session(session_id='review-parent-' + uuid4().hex, card=parent.card)
        await session.pre_run(inputs=None)
        try:
            tool = create_task_tool(parent_agent=parent, available_agents='effect_reviewer', language='cn')[0]
            delegated = await tool.invoke({'subagent_type': 'effect_reviewer',
                'task_description': json.dumps(evidence, ensure_ascii=False)}, session=session)
        finally:
            await session.post_run()
    finally:
        parent.deep_config.subagents = original
    if not delegated.success or not isinstance(delegated.data, dict):
        raise RuntimeError('Independent review subagent failed')
    return delegated.data.get('output')
