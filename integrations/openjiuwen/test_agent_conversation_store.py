import asyncio
import tempfile
import unittest

from .agent_conversation_store import ConversationStore, InteractionConflict
from .agent_session import TaskAgentSession


class ConversationStoreTests(unittest.IsolatedAsyncioTestCase):
    async def test_paused_round_claim_is_durable_and_not_replayed(self):
        with tempfile.TemporaryDirectory() as root:
            store=ConversationStore(root);await store.initialize()
            await store.save_paused_round('session','attempt','pause-1','原查询')
            restored=ConversationStore(root)
            self.assertEqual(await restored.paused_round('session','attempt'),
                             {'pauseId':'pause-1','query':'原查询','status':'paused'})
            await restored.transition_paused_round('session','attempt','pause-1','paused','resuming')
            with self.assertRaises(InteractionConflict):
                await store.transition_paused_round('session','attempt','pause-1','paused','resuming')
            self.assertEqual((await store.paused_round('session','attempt'))['status'],'resuming')
            await store.transition_paused_round('session','attempt','pause-1','resuming','resumed')
            await store.save_paused_round('session','attempt','pause-2','新查询')
            self.assertEqual((await store.paused_round('session','attempt'))['pauseId'],'pause-2')
            self.assertIsNone(await store.paused_round('other-session','attempt'))

    async def test_paused_instructions_remain_ordered_and_bound_to_attempt(self):
        with tempfile.TemporaryDirectory() as root:
            store=ConversationStore(root);await store.initialize()
            await store.queue_instruction('session','one','第一条','attempt-1')
            await store.queue_instruction('session','two','第二条','attempt-1')
            await store.queue_instruction('session','other','另一轮','attempt-2')
            self.assertEqual(await store.queued_instructions('session','attempt-1'),
                             [{'key':'one','text':'第一条'},{'key':'two','text':'第二条'}])
            await store.instruction_status('session','one','queued','sending')
            await store.instruction_status('session','one','sending','accepted')
            self.assertEqual(await store.queued_instructions('session','attempt-1'),[{'key':'two','text':'第二条'}])
            with self.assertRaises(InteractionConflict):
                await store.queue_instruction('session','two','第二条','attempt-2')

    async def test_instruction_table_upgrade_preserves_existing_messages(self):
        import aiosqlite
        with tempfile.TemporaryDirectory() as root:
            store=ConversationStore(root)
            async with aiosqlite.connect(store.path) as db:
                await db.execute('CREATE TABLE instructions(session_id TEXT NOT NULL,request_id TEXT NOT NULL,text TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(session_id,request_id))')
                await db.execute("INSERT INTO instructions VALUES('s','old','保留的消息','accepted')")
                await db.commit()
            await store.initialize()
            self.assertEqual(await store.get_instruction('s','old','保留的消息'),'accepted')
            self.assertEqual(await store.queue_instruction('s','new','暂停时补充','attempt-1'),'queued')
            self.assertEqual(await store.queued_instructions('s','attempt-1'),[{'key':'new','text':'暂停时补充'}])

    async def test_latest_task_goal_is_durable_and_scoped_to_session(self):
        with tempfile.TemporaryDirectory() as root:
            store = ConversationStore(root)
            await store.initialize()
            await store.append('session-1', 'goal-1', 'task_goal', {'goal': '原范围', 'attemptId': 'a'})
            await store.append('session-2', 'goal-2', 'task_goal', {'goal': '其他用户范围', 'attemptId': 'b'})
            sequence = await store.append('session-1', 'goal-3', 'task_goal', {'goal': '新范围', 'attemptId': 'c'})
            restored = ConversationStore(root)
            events = await restored.task_goals_since('session-1', 0)
            self.assertEqual(len(events), 2)
            self.assertEqual(events[-1]['sequence'], sequence)
            self.assertEqual(events[-1]['payload'], {'goal': '新范围', 'attemptId': 'c'})
            self.assertTrue(events[-1]['createdAt'].endswith('Z'))
            self.assertEqual(await restored.task_goals_since('session-1', sequence), [])
            self.assertEqual(await restored.task_goals_since('session-3', 0), [])

    async def test_questions_and_answers_survive_recreation_and_are_idempotent(self):
        with tempfile.TemporaryDirectory() as root:
            store = ConversationStore(root)
            await store.initialize()
            question = {'id': 'call-1', 'value': {'questions': [{'question': '如何处理？'}]}}
            self.assertEqual(await store.ask('session-1', 'call-1', question), 'pending')
            self.assertEqual(await store.ask('session-1', 'call-1', question), 'pending')
            store = ConversationStore(root)
            self.assertEqual((await store.interactions('session-1'))[0]['request'], question)
            answers = {'如何处理？': '保留服务'}
            with self.assertRaisesRegex(InteractionConflict, 'do not match'):
                await store.answer('session-1', 'call-1', {'其他问题': '保留服务'})
            self.assertEqual(await store.answer('session-1', 'call-1', answers), 'answered')
            self.assertEqual(await store.answer('session-1', 'call-1', answers), 'answered')
            with self.assertRaises(InteractionConflict):
                await store.answer('session-1', 'call-1', {'如何处理？': '新建服务'})
            self.assertEqual([event['kind'] for event in await store.events('session-1')], ['question', 'answer'])
            self.assertEqual(await store.interactions('session-2'), [])
            await store.begin_delivery('session-1', 'call-1')
            with self.assertRaises(InteractionConflict):
                await store.begin_delivery('session-1', 'call-1')
            await store.delivered('session-1', 'call-1')
            self.assertEqual(await store.interactions('session-1'), [])
            with self.assertRaises(InteractionConflict):
                await store.answer('session-2', 'call-1', answers)

    async def test_timeline_paginates_without_truncation_or_duplicate_requests(self):
        with tempfile.TemporaryDirectory() as root:
            store = ConversationStore(root)
            await store.initialize()
            for i in range(230):
                await store.append('session-1', f'message-{i}', 'message', {'text': str(i)})
            original = await store.append('session-1', 'message-20', 'message', {'text': '20'})
            with self.assertRaises(InteractionConflict):
                await store.append('session-1', 'message-20', 'message', {'text': 'changed'})
            page1 = await store.events('session-1', limit=100)
            page2 = await store.events('session-1', after=page1[-1]['sequence'], limit=100)
            page3 = await store.events('session-1', after=page2[-1]['sequence'], limit=100)
            events = page1 + page2 + page3
            self.assertEqual(len(events), 230)
            self.assertEqual(events[20]['sequence'], original)
            self.assertEqual(events[-1]['payload']['text'], '229')

    async def test_concurrent_answer_is_stored_once(self):
        with tempfile.TemporaryDirectory() as root:
            store = ConversationStore(root)
            await store.initialize()
            await store.ask('session-1', 'call-1', {'question': '选择？'})
            results = await asyncio.gather(*[
                store.answer('session-1', 'call-1', {'选择？': 'A'}) for _ in range(4)])
            self.assertEqual(results, ['answered'] * 4)
            self.assertEqual(len(await store.events('session-1')), 2)

    async def test_interrupted_answer_delivery_is_not_replayed_implicitly(self):
        class FailedSession(TaskAgentSession):
            async def _start(self):
                pass
            async def run(self, _inputs):
                raise RuntimeError('connection lost during execution')

        with tempfile.TemporaryDirectory() as root:
            store = ConversationStore(root)
            await store.initialize()
            await store.ask('session-1', 'call-1', {'question': '选择？'})
            session = FailedSession(None, 'session-1', None, store)
            with self.assertRaisesRegex(RuntimeError, 'connection lost'):
                await session.answer('call-1', {'选择？': 'A'})
            self.assertEqual((await store.interactions('session-1'))[0]['status'], 'delivering')
            with self.assertRaises(InteractionConflict):
                await session.answer('call-1', {'选择？': 'A'})

    async def test_start_failure_preserves_answer_as_safe_to_retry(self):
        class FailedStart(TaskAgentSession):
            async def _start(self):
                raise RuntimeError('startup failed')

        with tempfile.TemporaryDirectory() as root:
            store = ConversationStore(root)
            await store.initialize()
            await store.ask('session-1', 'call-1', {'question': '选择？'})
            session = FailedStart(None, 'session-1', None, store)
            with self.assertRaisesRegex(RuntimeError, 'startup failed'):
                await session.answer('call-1', {'选择？': 'A'})
            interaction = (await store.interactions('session-1'))[0]
            self.assertEqual(interaction['status'], 'answered')
            self.assertEqual(interaction['answer'], {'选择？': 'A'})

    async def test_instruction_is_durable_idempotent_and_not_implicitly_replayed(self):
        with tempfile.TemporaryDirectory() as root:
            store = ConversationStore(root)
            await store.initialize()
            self.assertEqual(await store.queue_instruction('s', 'req-1', '保留服务'), 'queued')
            self.assertEqual((await store.events('s'))[0]['deliveryStatus'], 'queued')
            await store.instruction_status('s', 'req-1', 'queued', 'sending')
            self.assertEqual((await store.events('s'))[0]['deliveryStatus'], 'sending')
            store = ConversationStore(root)
            self.assertEqual(await store.queue_instruction('s', 'req-1', '保留服务'), 'sending')
            with self.assertRaises(InteractionConflict):
                await store.instruction_status('s', 'req-1', 'queued', 'sending')
            with self.assertRaises(InteractionConflict):
                await store.queue_instruction('s', 'req-1', '删除服务')
            await store.instruction_status('s', 'req-1', 'sending', 'accepted')
            self.assertEqual((await store.events('s'))[0]['deliveryStatus'], 'accepted')
            self.assertEqual(await store.queue_instruction('s', 'req-1', '保留服务'), 'accepted')
            self.assertEqual(len(await store.events('s')), 1)
            await store.queue_instruction('s', 'req-2', '检查接口')
            await store.instruction_status('s', 'req-2', 'queued', 'sending')
            await store.instruction_status('s', 'req-2', 'sending', 'uncertain')
            await store.queue_instruction('other', 'req-2', '另一任务')
            self.assertEqual((await store.events('s'))[-1]['deliveryStatus'], 'uncertain')
            self.assertEqual((await store.events('other'))[-1]['deliveryStatus'], 'queued')
