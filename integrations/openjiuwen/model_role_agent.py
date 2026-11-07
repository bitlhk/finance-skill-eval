"""Runtime event projection over the shared native role executor."""
from .agent_protocol import emit


async def run(body, output):
    from agents.model_roles import execute_role
    from runtime.models import ModelCompletionError
    try:
        result = await execute_role(body, output)
        emit(output, {'type': 'result', **result})
    except ModelCompletionError as error:
        emit(output, {'type': 'error', 'code': error.code, 'message': str(error), 'httpStatus': error.http_status})
    except Exception:
        emit(output, {'type': 'error', 'message': '平台 Agent 执行失败'})
