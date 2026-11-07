"""Record an explicit user-requested budget change for the task host."""
from uuid import uuid4

from openjiuwen.core.foundation.tool import LocalFunction, ToolCard


class _BudgetTool(LocalFunction):
    async def invoke(self, inputs, **kwargs):
        # The SDK schema formatter coerces booleans to integers. Validate the
        # original values first, before the distinction is lost.
        if isinstance(inputs, dict):
            for name in ('additional_rounds', 'additional_seconds'):
                if name in inputs and inputs[name] is not None and type(inputs[name]) is not int:
                    return {'accepted': False, 'reason': '预算增量必须是整数'}
            if 'cancel' in inputs and inputs['cancel'] is not None and type(inputs['cancel']) is not bool:
                return {'accepted': False, 'reason': '取消标记无效'}
        return await super().invoke(inputs, **kwargs)


def build_budget_continuation_tool(conversation, session_id, attempt_id, owner_id):
    async def request_optimization_continuation(additional_rounds=None, additional_seconds=None, cancel=False):
        # LocalFunction supplies None for omitted optional schema properties.
        if cancel is not None and type(cancel) is not bool:
            return {'accepted': False, 'reason': '取消标记无效'}
        if cancel:
            if additional_rounds is not None or additional_seconds is not None:
                return {'accepted': False, 'reason': '取消请求不能同时增加预算'}
            sequence = await conversation.append(session_id, 'optimization-budget:' + uuid4().hex,
                'optimization_budget_request', {'attemptId':attempt_id, 'ownerAttemptId':owner_id, 'cancelled':True})
            return {'accepted': True, 'sequence':sequence, 'note':'已撤销本轮尚未提交的预算续跑请求。'}
        if additional_rounds is None and additional_seconds is None:
            return {'accepted': False, 'reason': '请提供用户明确要求增加的轮次或时间'}
        if additional_rounds is not None and (type(additional_rounds) is not int or not 1 <= additional_rounds <= 1000):
            return {'accepted': False, 'reason': '增加的轮次须为 1 至 1000 的整数'}
        if additional_seconds is not None and (type(additional_seconds) is not int or not 60 <= additional_seconds <= 7200):
            return {'accepted': False, 'reason': '增加的时间须为 60 至 7200 秒的整数'}
        payload = {'attemptId': attempt_id, 'ownerAttemptId': owner_id,
                   **({'additionalRounds': additional_rounds} if additional_rounds is not None else {}),
                   **({'additionalSeconds': additional_seconds} if additional_seconds is not None else {})}
        sequence = await conversation.append(session_id, 'optimization-budget:' + uuid4().hex,
                                             'optimization_budget_request', payload)
        return {'accepted': True, 'sequence': sequence,
                'note': '已记录请求；本轮结束后平台会核对原任务、预算及评测条件，核对通过才继续。'}

    return _BudgetTool(ToolCard(id='migration-optimization-continuation', name='request_optimization_continuation',
        description='仅当用户明确要求为当前暂停或中断的优化增加具体轮次或时间并继续时调用；不得猜测数字，含糊时先询问。用户撤销本轮尚未执行的请求时传 cancel=true。时间用秒表示。调用后结束当前回复，不修改文件或启动其他评测。平台核对后继续原优化。',
        input_params={'type': 'object', 'properties': {'additional_rounds': {'type': 'integer'},
            'additional_seconds': {'type': 'integer'}, 'cancel': {'type': 'boolean'}}}), request_optimization_continuation)


async def latest_budget_request(conversation, session_id, attempt_id):
    after, latest = 0, None
    while True:
        page = await conversation.events(session_id, after=after, limit=500)
        for event in page:
            payload = event.get('payload') or {}
            if event.get('kind') == 'optimization_budget_request' and payload.get('attemptId') == attempt_id:
                latest = None if payload.get('cancelled') is True else payload
        if len(page) < 500:
            return latest
        after = page[-1]['sequence']
