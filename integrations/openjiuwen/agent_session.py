"""OpenJiuwen checkpoint setup and stable identities for platform task sessions.

The host owns task authorization and the single-writer lease. This module only
adapts the SDK's persistence; it does not serialize Agent messages itself.
"""

import asyncio
import json
from pathlib import Path

from openjiuwen.core.session.checkpointer import CheckpointerFactory
from openjiuwen.core.session.checkpointer.checkpointer import CheckpointerConfig
from openjiuwen.core.single_agent.schema.agent_card import AgentCard
from openjiuwen.core.session import InteractiveInput

try:
    from .agent_activity import AgentStreamAccumulator
    from .session_identity import task_session_identity
except ImportError:
    from agent_activity import AgentStreamAccumulator
    from session_identity import task_session_identity


def task_agent_card() -> AgentCard:
    # SDK checkpoint keys contain both session ID and card ID. A stable card
    # lets a restarted host recover the same session while session IDs isolate tasks.
    return AgentCard(id='finance-migration-main', name='migration-main',
                     description='Enterprise skill migration task agent')


async def install_task_checkpointer(data_root: str | Path):
    """Install the SDK SQLite checkpointer once in the dedicated Agent host.

    The database must be on durable storage; SQLite alone is not a distributed
    execution lease and must not be treated as multi-host ownership protection.
    """
    root = Path(data_root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    checkpointer = await CheckpointerFactory.create(CheckpointerConfig(
        type='persistence', conf={'db_type': 'sqlite', 'db_path': str(root / 'agent-checkpoints.db')}))
    CheckpointerFactory.set_default_checkpointer(checkpointer)
    return checkpointer


async def emit_round_boundary(session, round_id: int, result_type: str | None, kind: str = 'finished'):
    """Order a NativeHarness round marker after its stream events in the SDK queue."""
    from openjiuwen.core.session.stream import OutputSchema
    await session.write_stream(OutputSchema(type='platform_round_end', index=0,
        payload={'roundId': round_id, 'resultType': result_type, 'kind': kind}))


class TaskAgentSession:
    """Run and resume a task using the SDK's persisted conversation state.

    Authorization, durable interaction records and cross-process ownership are
    provided by the task host; this local lock prevents concurrent invocations
    only within this session instance.
    """

    def __init__(self, agent, session_id: str, activity, conversation_store=None, attempt_id=None, pause_hook=None):
        if not session_id:
            raise ValueError('session ID is required')
        self.agent = agent
        self.session_id = session_id
        self.activity = activity
        self.conversation_store = conversation_store
        self.attempt_id = attempt_id
        self._pause_id = None
        self._pause_hook = pause_hook
        self._lock = asyncio.Lock()
        self._start_lock = asyncio.Lock()
        self._started = False
        self._sdk_session = None
        self._round_ready = asyncio.Event()
        self._round_results = {}
        self._round_starts = 0
        self._control_lock = asyncio.Lock()

    async def answer(self, interaction_id: str, answers: dict[str, str]):
        if not interaction_id or not isinstance(answers, dict) or not answers:
            raise ValueError('interaction ID and answers are required')
        if any(not isinstance(key, str) or not key or not isinstance(value, str)
               for key, value in answers.items()):
            raise ValueError('answers must map question text to answer text')
        input_value = InteractiveInput()
        input_value.update(interaction_id, {'answers': answers})
        if self.conversation_store:
            await self.conversation_store.answer(self.session_id, interaction_id, answers)
            # Startup restores the checkpoint without submitting user input.
            # A failure here must remain safely retryable as 'answered', rather
            # than being recorded as an ambiguous in-flight delivery.
            await self._start()
            await self.conversation_store.begin_delivery(self.session_id, interaction_id)
        result = await self.run(input_value)
        if self.conversation_store:
            await self.conversation_store.delivered(self.session_id, interaction_id)
        return result
    async def _start(self):
        async with self._start_lock:
            if self._started:
                return
            from openjiuwen.core.session.agent import create_agent_session
            session = create_agent_session(session_id=self.session_id, card=self.agent.card,
                                           close_stream_on_post_run=False)
            await session.pre_run(inputs=None)
            async def on_round(*, kind, round_id, result=None, **_kwargs):
                if kind == 'started':
                    self._round_starts += 1
                if kind in ('finished', 'failed', 'aborted', 'paused'):
                    self._round_results[round_id] = result
                    await emit_round_boundary(session, round_id, (result or {}).get('result_type'), kind)
            await self.agent.subscribe(on_round=on_round)
            await self.agent.start(session=session)
            self._sdk_session = session
            self._started = True

    async def run(self, query, *, resume_paused=False, recover_checkpoint=False):
        if not isinstance(query, (str, InteractiveInput)):
            raise TypeError('query must be text or an InteractiveInput')
        if isinstance(query, str) and not query.strip() and not (resume_paused or recover_checkpoint):
            raise ValueError('query must not be empty')
        async with self._lock:
            await self._start()
            if recover_checkpoint:
                record = await self.conversation_store.recovery_round(self.session_id, self.attempt_id)
                if not record or record['status'] not in ('running', 'finished'):
                    raise RuntimeError('没有可恢复的执行记录；请先核对待答问题或原任务状态')
                tools = await self.conversation_store.recovery_tools(self.session_id, self.attempt_id)
                query = record['query'] + '\n\n' + (
                    'Runtime 已重建。本次继续同一个任务，从框架最后保存的上下文与现有工程恢复。'
                    '先检查工作区、任务记录与已有结果，再继续未完成工作；不要从头重复执行。'
                    '以下仅是已观察到的调用边界，不是业务成功证明。started/uncertain 表示结果未确认，failed 也可能产生部分副作用。'
                    '对于可能有外部副作用的操作，先用只读查询核对原操作；无法核对时暂停该操作并询问用户，禁止盲目重试。\n'
                ) + json.dumps(tools, ensure_ascii=False)
                self.activity.send('progress', '正在从已保存的上下文和工程恢复任务')
            elif isinstance(query, str) and not resume_paused and self.conversation_store and self.attempt_id:
                # Save a genuine SDK recovery point before recording a runnable
                # query. The query receipt is not a second context engine.
                await self._sdk_session.commit()
                await self.conversation_store.save_recovery_round(self.session_id, self.attempt_id, query)
            output = self.agent.outputs()
            if resume_paused:
                if not self.conversation_store or not self.attempt_id:
                    raise RuntimeError('缺少暂停记录')
                paused = await self.conversation_store.paused_round(self.session_id, self.attempt_id)
                if not paused or paused['status'] != 'paused' or not paused['query']:
                    raise RuntimeError('暂停记录不可安全恢复')
                await self.conversation_store.transition_paused_round(self.session_id, self.attempt_id, paused['pauseId'], 'paused', 'resuming')
                queued = await self.conversation_store.queued_instructions(self.session_id, self.attempt_id)
                for item in queued:
                    await self.conversation_store.instruction_status(self.session_id, item['key'], 'queued', 'sending')
                if queued:
                    queues = self.agent.event_handler.interaction_queues
                    if queues is None:
                        raise RuntimeError('Framework steering queue is unavailable')
                    for item in queued:
                        queues.push_steer(item['text'])
                starts_before_resume = self._round_starts
                await self.agent.resume(query=paused['query'])
                if self._round_starts == starts_before_resume:
                    raise RuntimeError('框架未确认继续原执行，状态待核对')
                await self.conversation_store.transition_paused_round(self.session_id, self.attempt_id, paused['pauseId'], 'resuming', 'resumed')
                for item in queued:
                    await self.conversation_store.instruction_status(self.session_id, item['key'], 'sending', 'accepted')
            else:
                await self.agent.send(query)
            self._round_ready.set()
            try:
                accumulator = AgentStreamAccumulator(self.activity)
                result = None
                async for chunk in output:
                    data = chunk.model_dump() if hasattr(chunk, 'model_dump') else chunk
                    if isinstance(data, dict) and data.get('type') == 'platform_round_end':
                        marker = data.get('payload') or {}
                        round_result = self._round_results.pop(marker.get('roundId'), None) or {}
                        if marker.get('kind') == 'paused':
                            # The SDK rollback marker bypasses its session stream.
                            # This ordered barrier follows any earlier queued chunks.
                            if accumulator.rollback_pending:
                                accumulator.discard_rewound_output()
                                accumulator.rollback_pending = False
                            continue
                        if marker.get('kind') != 'finished':
                            raise RuntimeError(getattr(self.activity, 'last_model_error', None) or 'Agent 执行已中止或失败')
                        if marker.get('resultType') == 'interrupt' and not accumulator.interactions:
                            raise RuntimeError('框架中断缺少交互事件')
                        try:
                            result = accumulator.result()
                        except RuntimeError:
                            if not isinstance(round_result.get('output'), str) or not round_result['output']:
                                raise
                            result = round_result
                        break
                    accumulator.feed(chunk)
                if result is None:
                    raise RuntimeError('Agent 输出流在轮次结束前关闭')
                # A finished output stream is not yet a durable session. Keep
                # the round active until its checkpoint and questions are saved.
                await self._sdk_session.commit()
                if self.conversation_store and result.get('result_type') == 'interrupt':
                    flush = getattr(self.activity, 'flush', None)
                    if callable(flush):
                        await flush()
                    for interaction in result.get('interactions', []):
                        identity = interaction.get('interaction_id') or interaction.get('id')
                        if not isinstance(identity, str) or not identity:
                            raise ValueError('framework interaction has no ID')
                        await self.conversation_store.ask(self.session_id, identity, interaction)
                if self.conversation_store and self.attempt_id:
                    await self.conversation_store.finish_recovery_round(self.session_id, self.attempt_id,
                        'waiting' if result.get('result_type') == 'interrupt' else 'finished')
                return result
            finally:
                self._round_ready.clear()

    async def steer(self, text: str, request_id: str):
        if not isinstance(text, str) or not text.strip() or not request_id:
            raise ValueError('instruction and request ID are required')
        await asyncio.wait_for(self._round_ready.wait(), timeout=10)
        # The framework dispatches STEER as a new follow-up if there is no
        # active round. Do not silently turn a late instruction into a new task.
        from openjiuwen.agent_teams.harness.state import HarnessState
        for _ in range(100):
            if self.agent.state == HarnessState.RUNNING:
                break
            if not self._round_ready.is_set():
                raise RuntimeError('The task round has already ended')
            await asyncio.sleep(0.01)
        else:
            raise RuntimeError('The task round is not ready for input')
        await self.agent.send(text, immediate=True)

    async def close(self):
        if self._started:
            await self.agent.stop()
            self._started = False

    async def pause(self):
        """Pause only after the native boundary and checkpoint are durable."""
        from openjiuwen.agent_teams.harness.state import HarnessState
        async with self._control_lock:
            if not self._started or not self._round_ready.is_set() or self.agent.state != HarnessState.RUNNING:
                return False
            await self.agent.pause()
            if self.agent.state != HarnessState.PAUSED:
                return False
            await self._sdk_session.commit()
            if self._pause_hook is not None:
                await self._pause_hook()
            if self.conversation_store and self.attempt_id:
                from uuid import uuid4
                pause_id = uuid4().hex
                await self.conversation_store.save_paused_round(self.session_id, self.attempt_id, pause_id, self.agent.paused_query)
                self._pause_id = pause_id
            self.activity.send('paused', '已暂停，当前工作已保存')
            return True

    async def resume(self, instructions=()):
        from openjiuwen.agent_teams.harness.state import HarnessState
        async with self._control_lock:
            if not self._started or self.agent.state != HarnessState.PAUSED:
                return False
            if any(not isinstance(text, str) or not text.strip() for text in instructions):
                raise ValueError('Invalid queued instruction')
            if self.conversation_store and self.attempt_id:
                if not self._pause_id:
                    raise RuntimeError('Paused round is not recorded')
                await self.conversation_store.transition_paused_round(self.session_id, self.attempt_id, self._pause_id, 'paused', 'resuming')
            if instructions:
                # Same SDK steering queue used by NativeHarness.send(immediate=True).
                # Enqueue before continuation starts so a fast model cannot finish
                # before the user's paused instructions have been delivered.
                queues = self.agent.event_handler.interaction_queues
                if queues is None:
                    raise RuntimeError('Framework steering queue is unavailable')
                for text in instructions:
                    queues.push_steer(text)
            starts_before_resume = self._round_starts
            await self.agent.resume()
            if self._round_starts == starts_before_resume:
                return False
            if self.conversation_store and self.attempt_id:
                await self.conversation_store.transition_paused_round(self.session_id, self.attempt_id, self._pause_id, 'resuming', 'resumed')
                self._pause_id = None
            self.activity.send('resumed', '已继续当前任务')
            return True

    async def control_state(self):
        if not self._started:
            return 'UNAVAILABLE'
        value = self.agent.state.value
        if value == 'paused' and self.conversation_store and self.attempt_id:
            record = await self.conversation_store.paused_round(self.session_id, self.attempt_id)
            if not record or record['status'] != 'paused':
                return 'UNAVAILABLE'
        return {'running': 'RUNNING', 'pausing': 'PAUSING', 'paused': 'PAUSED', 'idle': 'IDLE'}.get(value, 'UNAVAILABLE')

    async def cancel(self):
        from openjiuwen.agent_teams.harness.state import HarnessState
        async with self._control_lock:
            if not self._started or self.agent.state not in (HarnessState.RUNNING, HarnessState.PAUSING, HarnessState.PAUSED):
                return False
            was_paused = self.agent.state == HarnessState.PAUSED
            await self.agent.abort(immediate=True)
            if was_paused:
                if self.conversation_store and self.attempt_id and self._pause_id:
                    await self.conversation_store.transition_paused_round(self.session_id, self.attempt_id, self._pause_id, 'paused', 'cancelled')
                    self._pause_id = None
                # NativeHarness's paused->idle abort has no round callback;
                # release the existing single output consumer explicitly.
                await emit_round_boundary(self._sdk_session, -1, None, 'aborted')
        # cancel_round requests cancellation and can return before the output
        # consumer has observed the end of the active round. Do not acknowledge
        # it as stopped until that consumer has actually left the round.
        for _ in range(1000):
            if not self._round_ready.is_set():
                return True
            await asyncio.sleep(0.01)
        return False
