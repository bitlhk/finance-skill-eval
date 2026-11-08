"""Public execution activity; never forward reasoning or arbitrary tool arguments."""
import asyncio
import json
import re
from pathlib import Path
from uuid import uuid4

from openjiuwen.harness.rails.base import AgentRail
try:
    from .agent_protocol import emit
except ImportError:
    from agent_protocol import emit


class ActivityRail(AgentRail):
    def __init__(self, protocol, secrets=()):
        self.protocol = protocol
        self.secrets = [value for value in secrets if isinstance(value, str) and value]
        self.response = ''
        self.last_model_error = None
        self._conversation_store = None
        self._conversation_session = None
        self._pending_write = None
        self._todo_directory = None
        self._candidate_digest = None
        self._review_starts = {}
        self._review_snapshots = None
        self.delivery_reviews = []
        self._attempt_id = None

    def attach_conversation(self, store, session_id, todo_directory=None, candidate_digest=None, attempt_id=None):
        self._conversation_store = store
        self._conversation_session = session_id
        self._todo_directory = Path(todo_directory) if todo_directory else None
        self._candidate_digest = candidate_digest
        self._attempt_id = attempt_id

    def attach_review_snapshots(self, snapshots):
        self._review_snapshots = snapshots

    async def flush(self):
        if self._pending_write is not None:
            await self._pending_write

    async def persisted_delivery_reviews(self):
        if self._conversation_store is None or not self._attempt_id:
            return self.delivery_reviews
        await self.flush()
        reviews, after = [], 0
        while True:
            page = await self._conversation_store.events(self._conversation_session, after=after, limit=500)
            for event in page:
                payload = event.get('payload') or {}
                if event.get('kind') == 'delivery_review' and payload.get('attemptId') == self._attempt_id:
                    reviews.append({key:value for key,value in payload.items() if key != 'attemptId'})
            if len(page) < 500:
                return reviews[-20:]
            after = page[-1]['sequence']

    def _record(self, kind, payload):
        if self._conversation_store is None:
            return
        previous = self._pending_write
        async def record():
            if previous is not None:
                await previous
            await self._conversation_store.append(self._conversation_session, 'activity:' + uuid4().hex, kind, payload)
        self._pending_write = asyncio.create_task(record())

    def send(self, kind, label, text=None):
        event = {'kind': kind, 'label': self._clean(label)}
        if text:
            event['text'] = self._clean(str(text))[:12000]
        emit(self.protocol, {'activity': event})
        if self._conversation_store is not None and kind in {'message', 'tool_start', 'tool_end', 'tool_error', 'warning'}:
            self._record(kind, event)

    def _clean(self, value):
        for secret in self.secrets:
            value = value.replace(secret, '[redacted]')
        return value

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
        self.last_model_error = None
        self.response = ''
        self.send('model_start', '等待模型响应')

    async def after_model_call(self, ctx):
        self.send('model_end', '模型响应结束')
        response = getattr(ctx.inputs, 'response', None)
        if response is not None:
            self.last_model_error = None
        content = getattr(response, 'content', None)
        if isinstance(content, str) and content.strip():
            self.send('message', 'Agent', content)
        elif response is not None and not getattr(response, 'tool_calls', None):
            self.last_model_error = '模型没有返回有效回答或工具调用，工作与已完成验证已保留，可继续原任务'
            self.send('model_error', self.last_model_error)

    async def before_tool_call(self, ctx):
        if getattr(ctx.inputs, 'tool_name', '') == 'ask_user':
            return
        args = getattr(ctx.inputs, 'tool_args', None)
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except ValueError:
                args = None
        call = getattr(ctx.inputs, 'tool_call', None)
        call_id = call.get('id') if isinstance(call, dict) else getattr(call, 'id', None)
        if (getattr(ctx.inputs, 'tool_name', '') == 'task_tool' and isinstance(args, dict)
                and args.get('subagent_type') == 'migration_delivery_reviewer' and call_id):
            if self._review_snapshots:
                self._review_starts[call_id] = await self._review_snapshots.start(call_id)
            else:
                try:
                    self._review_starts[call_id] = self._candidate_digest() if self._candidate_digest else None
                except (OSError, ValueError):
                    self._review_starts[call_id] = None
        elif (getattr(ctx.inputs, 'tool_name', '') == 'task_tool' and isinstance(args, dict)
              and args.get('subagent_type') == 'migration_delivery_reviewer' and self._review_snapshots):
            raise ValueError('Review call ID is required')
        self.send('tool_start', '调用工具：' + str(getattr(ctx.inputs, 'tool_name', '工具')))
        if call_id and self._attempt_id:
            self._record('tool_boundary', {'attemptId': self._attempt_id, 'callId': self._clean(str(call_id)),
                'name': self._clean(str(getattr(ctx.inputs, 'tool_name', '工具'))), 'status': 'started'})
            # A start receipt must be durable before a tool can cause effects.
            await self.flush()

    async def after_tool_call(self, ctx):
        tool_name = getattr(ctx.inputs, 'tool_name', '')
        if tool_name == 'ask_user':
            return
        result = getattr(ctx.inputs, 'tool_result', None)
        payload = result if isinstance(result, dict) else getattr(result, 'data', None)
        failed = getattr(result, 'success', None) is False or (isinstance(payload, dict) and (payload.get('passed') is False or payload.get('accepted') is False))
        if tool_name == 'task_tool' and failed:
            call = getattr(ctx.inputs, 'tool_call', None)
            call_id = call.get('id') if isinstance(call, dict) else getattr(call, 'id', None)
            if call_id:
                self._review_starts.pop(call_id, None)
                if self._review_snapshots:
                    await self._review_snapshots.finish(call_id)
        if tool_name == 'task_tool' and not failed and isinstance(payload, dict):
            args = getattr(ctx.inputs, 'tool_args', None)
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except ValueError:
                    args = None
            if isinstance(args, dict) and args.get('subagent_type') == 'migration_delivery_reviewer':
                call = getattr(ctx.inputs, 'tool_call', None)
                call_id = call.get('id') if isinstance(call, dict) else getattr(call, 'id', None)
                initial = self._review_starts.pop(call_id, None) if call_id else None
                frozen = await self._review_snapshots.finish(call_id) if call_id and self._review_snapshots else None
                frozen_digest = frozen.get('digest') if isinstance(frozen, dict) else None
                submitted = frozen.get('review') if isinstance(frozen, dict) else None
                if frozen_digest and frozen_digest == initial and isinstance(submitted, dict):
                    saved = {'workspaceDigest':frozen_digest,
                        'decision':submitted['decision'], 'summary':self._clean(submitted['summary']),
                        'issues':[self._clean(item) for item in submitted['issues']],
                        'citations':[{'path':self._clean(item['path']),'quote':self._clean(item['quote'])} for item in submitted['citations']]}
                    if isinstance(submitted.get('basicReview'), dict):
                        basic=submitted['basicReview']
                        saved['basicReview']={'status':basic['status'],'scope':self._clean(basic['scope']),
                            'reason':self._clean(basic['reason']),'references':basic['references'],
                            **({'coversTaskScope':basic['coversTaskScope']} if 'coversTaskScope' in basic else {})}
                    self.delivery_reviews.append(saved)
                    self._record('delivery_review', {**saved, **({'attemptId':self._attempt_id} if self._attempt_id else {})})
                output = payload.get('output')
                if isinstance(output, str) and output.strip():
                    try:
                        digest = self._candidate_digest() if self._candidate_digest else None
                    except (OSError, ValueError):
                        digest = None
                    stability = 'frozen' if frozen_digest and frozen_digest == initial else 'stable_boundaries' if initial and digest and initial == digest else 'changed' if initial and digest else 'unverified'
                    self._record('work_product', {'id': 'independent-delivery-review', 'title': '独立交付审查建议',
                        'content': self._clean(output)[:100000], 'reviewStability': stability,
                        **({'workspaceDigest': frozen_digest if stability == 'frozen' else digest} if stability in ('frozen', 'stable_boundaries') else {})})
        if tool_name == 'run_project_command' and isinstance(payload, dict):
            failed = failed or payload.get('status') in {'FAILED', 'UNAVAILABLE', 'TIMEOUT'}
        self.send('tool_error' if failed else 'tool_end',
                  ('工具失败：' if failed else '工具结束：') + str(tool_name or '工具'),
                  str((payload.get('error') or payload.get('reason') or payload.get('stderr') or (payload.get('output') if tool_name == 'run_project_command' else '') or '') if isinstance(payload, dict) else getattr(result, 'error', '') or '')[:1500] if failed else None)
        call = getattr(ctx.inputs, 'tool_call', None)
        call_id = call.get('id') if isinstance(call, dict) else getattr(call, 'id', None)
        if call_id and self._attempt_id:
            self._record('tool_boundary', {'attemptId': self._attempt_id, 'callId': self._clean(str(call_id)),
                'name': self._clean(str(tool_name)), 'status': 'failed' if failed else 'finished'})
            await self.flush()
        if not failed and self._todo_directory is not None and tool_name in {'todo_create', 'todo_modify'}:
            try:
                file = self._todo_directory / self._conversation_session / 'todo.json'
                items = json.loads(await asyncio.to_thread(file.read_text, encoding='utf-8'))
                if isinstance(items, list):
                    self._record('plan', {'items': [
                        {'id': self._clean(str(item.get('id') or '')),
                         'content': self._clean(str(item.get('content') or '')),
                         'status': item.get('status') if item.get('status') in ('pending', 'in_progress', 'completed', 'cancelled') else 'pending'}
                        for item in items if isinstance(item, dict)
                    ]})
            except (OSError, ValueError):
                self.send('warning', '计划更新暂时无法展示')

    async def on_tool_exception(self, ctx):
        if getattr(ctx.inputs, 'tool_name', '') == 'ask_user':
            return
        call = getattr(ctx.inputs, 'tool_call', None)
        call_id = call.get('id') if isinstance(call, dict) else getattr(call, 'id', None)
        if call_id:
            self._review_starts.pop(call_id, None)
            if self._review_snapshots:
                await self._review_snapshots.finish(call_id)
        self.send('tool_error', '工具调用异常')
        if call_id and self._attempt_id:
            self._record('tool_boundary', {'attemptId': self._attempt_id, 'callId': self._clean(str(call_id)),
                'name': self._clean(str(getattr(ctx.inputs, 'tool_name', '工具'))), 'status': 'uncertain'})
            await self.flush()

    async def on_model_exception(self, ctx):
        # Provider exceptions can include prompts, credentials or response bodies.
        # Publish only an allowlisted diagnosis, never the exception text itself.
        error = getattr(ctx, 'exception', None)
        chain, seen = [], set()
        while error is not None and id(error) not in seen and len(chain) < 8:
            seen.add(id(error))
            chain.append(error)
            error = getattr(error, '__cause__', None) or getattr(error, '__context__', None)
        statuses = []
        for item in chain:
            status = getattr(item, 'status_code', None)
            if isinstance(status, int) and 400 <= status <= 599:
                statuses.append(status)
            # Some SDK wrappers retain only the HTTP status in their message.
            statuses.extend(int(m) for m in re.findall(r'(?i)\b(?:http|status(?: code)?)\s*[:=]?\s*([45]\d\d)\b', str(item)))
        if statuses:
            label = f'模型请求失败（HTTP {statuses[0]}）'
            if statuses[0] == 429:
                label += '，请检查服务限流或配额后重试'
        elif any('timeout' in type(item).__name__.lower() or 'timeout' in str(item).lower()
                 or 'timed out' in str(item).lower() for item in chain):
            label = '模型请求超时'
        else:
            label = '模型请求失败，请检查模型服务及网络'
        self.last_model_error = label
        self.send('model_error', label)


class AgentStreamAccumulator:
    """Accumulate one framework round regardless of its streaming transport."""

    def __init__(self, activity):
        self.activity = activity
        self.parts = []
        self.final = None
        self.interactions = []
        self.rollback_pending = False
        self._archive_warning = False

    def discard_rewound_output(self):
        self.parts.clear()
        self.final = None
        self.interactions.clear()
        self.activity.response = ''
        self.activity.send('round_aborted', '当前未完成的输出已撤回，等待继续')

    def feed(self, chunk):
        data = chunk.model_dump() if hasattr(chunk, 'model_dump') else chunk
        if not isinstance(data, dict):
            return
        payload = data.get('payload')
        if not isinstance(payload, dict):
            return
        if data.get('type') == 'context.compression_state':
            try:
                from .context_archive_guard import ARCHIVE_FAILURE
            except ImportError:
                from context_archive_guard import ARCHIVE_FAILURE
            if (payload.get('status') == 'failed' and ARCHIVE_FAILURE in str(payload.get('error') or '')
                    and not self._archive_warning):
                self._archive_warning = True
                self.activity.send('warning', '上下文归档暂时不可用，已保留原始内容',
                    '请检查任务存储空间和写入权限；原始内容可能占用较多上下文。')
            return
        if data.get('type') == 'round_aborted':
            # NativeHarness can rewind a partially streamed model call on pause.
            # Those fragments are not part of the resumed framework context.
            self.rollback_pending = True
            self.discard_rewound_output()
            return
        if data.get('type') == '__interaction__':
            self.interactions.append(payload)
            return
        if payload.get('result_type') == 'error':
            raise RuntimeError(str(payload.get('output') or 'Agent stream failed'))
        if data.get('type') == 'llm_output' and isinstance(payload.get('content'), str):
            self.parts.append(payload['content'])
            self.activity.delta(payload['content'])
        elif data.get('type') == 'answer':
            self.final = dict(payload)
            if 'output' not in self.final and isinstance(self.final.get('content'), str):
                self.final['output'] = self.final['content']

    def result(self):
        # An interaction is an intentional suspension, even if the model emitted
        # text before requesting input. The host must retain the framework IDs.
        if self.interactions:
            return {'result_type': 'interrupt', 'interactions': self.interactions,
                    'output': ''.join(self.parts)}
        if self.final is not None and 'output' in self.final:
            return self.final
        if not self.parts:
            raise RuntimeError('Agent stream returned no answer')
        return {'output': ''.join(self.parts), 'result_type': 'answer'}


async def stream_agent(agent, inputs, activity):
    accumulator = AgentStreamAccumulator(activity)
    async for chunk in agent.stream(inputs):
        accumulator.feed(chunk)
    return accumulator.result()
