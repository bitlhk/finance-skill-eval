"""Single assembly boundary for platform engineering agents.

Callers supply task-specific tools and workspace boundaries; this module owns model
configuration, tracing, SDK defaults and execution. Business Runtime skill loading
is deliberately outside this platform-agent boundary.
"""


def assemble_agent(*, composition, body, bound, settings, workspace, operation,
                   tools, protocol, trace, kind, max_iterations=120, timeout_ms=300000,
                   prompt_suffix='', extra_rails=()):
    from openjiuwen.core.foundation.llm import init_model
    from openjiuwen.harness.factory import create_deep_agent
    from openjiuwen.harness.subagents.explore_agent import create_explore_agent
    from model_config import bind_model_auth, bind_agent_request_extensions
    from agent_activity import ActivityRail
    from harness_tools import ToolTraceRail, FilesystemOnlyRail

    names = [tool.card.name for tool in tools]
    composition.validate_tools(names)
    model = init_model('OpenAI', settings['model_name'], bound['apiKey'], bound['baseUrl'],
                       temperature=float(body.get('temperature', 0.2)),
                       max_tokens=int(body.get('maxTokens', 32000)),
                       timeout=int(body.get('modelTimeoutMs', timeout_ms)) / 1000)
    model = bind_model_auth(model, bound)
    model = bind_agent_request_extensions(model, settings, composition.definition['modelRole'])
    activity = ActivityRail(protocol, [bound.get('apiKey', ''), bound.get('baseUrl', '')])
    prompt = '\n\n'.join([composition.prompt, composition.guidance, composition.contract, prompt_suffix])
    prompt = prompt.replace('@@WORKSPACE_ROOT@@', str(workspace))
    factory = {'explore': create_explore_agent, 'deep': create_deep_agent}[kind]
    agent = factory(model=model, system_prompt=prompt, tools=tools, sys_operation=operation,
                    workspace=str(workspace), max_iterations=int(body.get('maxIterations', max_iterations)),
                    language='cn', rails=[activity, ToolTraceRail(trace), *extra_rails, FilesystemOnlyRail()],
                    prompt_mode='minimal', auto_create_workspace=False, enable_task_loop=False,
                    enable_read_image_multimodal=False)
    receipt_body = {**body, 'maxIterations': body.get('maxIterations', max_iterations),
                    'modelTimeoutMs': body.get('modelTimeoutMs', timeout_ms)}
    return agent, model, activity, composition.receipt(receipt_body, bound, names)
