"""Public execution activity; never forward reasoning or arbitrary tool arguments."""
from openjiuwen.harness.rails.base import AgentRail
from agent_protocol import emit


class ActivityRail(AgentRail):
    def __init__(self, protocol, secrets=()):
        self.protocol = protocol
        self.secrets = [value for value in secrets if isinstance(value, str) and value]
        self.response = ''

    def send(self, kind, label, text=None):
        def clean(value):
            for secret in self.secrets:
                value = value.replace(secret, '[redacted]')
            return value
        event = {'kind': kind, 'label': clean(label)}
        if text:
            event['text'] = clean(str(text))[:12000]
        emit(self.protocol, {'activity': event})

    def delta(self, text):
        self.response = (self.response + text)[-12000:]
        safe = self.response
        for secret in self.secrets:
            safe = safe.replace(secret, '[redacted]')
            for length in range(min(len(secret)-1, len(safe)), 0, -1):
                if safe.endswith(secret[:length]):
                    safe = safe[:-length] + '[redacted]'
                    break
        self.send('text_snapshot', '接收模型响应', safe)

    async def before_model_call(self, ctx):
        self.response = ''
        self.send('model_start', '等待模型响应')

    async def after_model_call(self, ctx):
        self.send('model_end', '模型响应结束')

    async def before_tool_call(self, ctx):
        self.send('tool_start', '调用工具：' + str(getattr(ctx.inputs, 'tool_name', '工具')))

    async def after_tool_call(self, ctx):
        result = getattr(ctx.inputs, 'tool_result', None)
        payload = result if isinstance(result, dict) else getattr(result, 'data', None)
        failed = getattr(result, 'success', None) is False or (isinstance(payload, dict) and payload.get('passed') is False)
        self.send('tool_error' if failed else 'tool_end',
                  ('工具失败：' if failed else '工具结束：') + str(getattr(ctx.inputs, 'tool_name', '工具')),
                  str((payload.get('error') or payload.get('stderr') or '') if isinstance(payload, dict) else getattr(result, 'error', '') or '')[:1500] if failed else None)

    async def on_tool_exception(self, ctx):
        self.send('tool_error', '工具调用异常')

    async def on_model_exception(self, ctx):
        self.send('model_error', '模型请求失败')


async def stream_agent(agent, inputs, activity):
    parts, final = [], None
    async for chunk in agent.stream(inputs):
        data = chunk.model_dump() if hasattr(chunk, 'model_dump') else chunk
        if not isinstance(data, dict):
            continue
        payload = data.get('payload')
        if not isinstance(payload, dict):
            continue
        if payload.get('result_type') == 'error':
            raise RuntimeError(str(payload.get('output') or 'Agent stream failed'))
        if data.get('type') == 'llm_output' and isinstance(payload.get('content'), str):
            parts.append(payload['content'])
            activity.delta(payload['content'])
        elif data.get('type') == 'answer':
            final = dict(payload)
            if 'output' not in final and isinstance(final.get('content'), str):
                final['output'] = final['content']
    if final is not None and 'output' in final:
        return final
    if not parts:
        raise RuntimeError('Agent stream returned no answer')
    return {'output': ''.join(parts), 'result_type': 'answer'}
