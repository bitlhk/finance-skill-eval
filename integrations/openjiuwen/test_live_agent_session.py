"""Exercise native DeepAgent steering while a model call is in flight."""
import asyncio
import json
import tempfile
import unittest


def native_test_agent(model, **kwargs):
    from openjiuwen.harness.factory import resolve_deep_agent_parts
    from openjiuwen.agent_teams.harness.native_harness import NativeHarness
    class Spec:
        def resolve_parts(self, _context):
            return resolve_deep_agent_parts(model, **kwargs)
    return NativeHarness(Spec())


class LiveAgentSessionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        import os
        from unittest.mock import patch
        # Local SDK fixtures must not inherit an operator's private reviewer.
        private_reviewer = patch.dict(os.environ, {'FINANCE_EVAL_JUDGE_BASE_URL': '', 'FINANCE_EVAL_JUDGE_API_KEY': ''})
        private_reviewer.start()
        self.addCleanup(private_reviewer.stop)

    async def test_delivery_subagent_uses_the_configured_reviewer_model(self):
        import io
        from pathlib import Path
        from unittest.mock import MagicMock, patch
        from openjiuwen.core.foundation.llm import init_model
        from openjiuwen.core.sys_operation import SysOperation
        from openjiuwen.core.sys_operation.base import OperationMode
        from openjiuwen.core.sys_operation.config import LocalWorkConfig
        from openjiuwen.core.sys_operation.sys_operation import SysOperationCard
        from .agent_execution import assemble_agent
        main = init_model('OpenAI', 'main-fixture', 'fixture', 'https://fixture.invalid/v1')
        reviewer = init_model('OpenAI', 'review-fixture', 'fixture', 'https://fixture.invalid/v1')
        with tempfile.TemporaryDirectory() as directory:
            operation = SysOperation(SysOperationCard(id='review-role-test', mode=OperationMode.LOCAL,
                work_config=LocalWorkConfig(restrict_to_sandbox=True, sandbox_root=[directory], shell_allowlist=[])))
            composition = MagicMock()
            composition.definition = {'modelRole': 'MIGRATION'}
            composition.receipt.return_value = {'resources': [], 'definitionDigest': 'fixture'}
            with patch('integrations.openjiuwen.model_config.create_model', side_effect=[main, reviewer]) as create, \
                    patch('runtime.models.configured_model_role', return_value={'configured': True}), \
                    patch('runtime.models.agent_role_binding', return_value=({'apiKey': 'review-secret', 'baseUrl': 'https://fixture.invalid/v1'}, {'modelId': 'review-fixture'})):
                agent, _, _, _ = assemble_agent(composition=composition, body={},
                    bound={'apiKey': 'main-secret'}, settings={'model_name': 'main-fixture'}, workspace=Path(directory),
                    operation=operation, tools=[], protocol=io.StringIO(), trace=[], kind='deep',
                    task_session={'skill_roots': [str(Path(__file__).resolve().parents[2] / 'src/resources/agents/v1/skills')]})
            children = {spec.agent_card.name: spec for spec in agent.deep_config.subagents}
            self.assertIs(children['migration_delivery_reviewer'].model, reviewer)
            self.assertIs(children['migration_investigator'].model, main)
            self.assertEqual(create.call_args_list[1].kwargs['role'], 'JUDGE')
            self.assertFalse(create.call_args_list[1].args[0]['supportsStreaming'])

    async def test_session_memory_compresses_and_survives_recreation(self):
        import httpx
        from pathlib import Path
        from contextlib import AsyncExitStack
        from unittest.mock import patch
        import shutil
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm.model import init_model
        from openjiuwen.core.context_engine.schema.config import ContextEngineConfig, CompressionRecallConfig
        from .context_archive_guard import TaskContextProcessorRail
        from openjiuwen.core.session.checkpointer import CheckpointerFactory
        from openjiuwen.core.context_engine.processor.forked.compressor.recall import recall_compressed_context
        from .agent_session import TaskAgentSession, install_task_checkpointer, task_agent_card
        from .agent_workspace import _filesystem_path

        calls = []
        async def respond(request):
            calls.append(json.loads(request.content))
            chunk = {'id':'fixture','object':'chat.completion.chunk','created':0,'model':'fixture',
                     'choices':[{'index':0,'delta':{'role':'assistant','content':'记录完成'},'finish_reason':'stop'}]}
            return httpx.Response(200,headers={'content-type':'text/event-stream'},
                text='data: '+json.dumps(chunk,ensure_ascii=False)+'\n\ndata: [DONE]\n\n')
        class Activity:
            def __init__(self): self.events=[]
            def delta(self, _text): pass
            def send(self, kind, label, text=None): self.events.append((kind,label,text))
        previous = CheckpointerFactory._default_checkpointer
        checkpointer = None
        try:
            async with AsyncExitStack() as stack:
                root=stack.enter_context(tempfile.TemporaryDirectory())
                checkpointer = await install_task_checkpointer(root)
                stack.push_async_callback(checkpointer._kv_store.engine.dispose)
                workspace_path=_filesystem_path((Path(root) / ('long-project-' * 5)).resolve())
                workspace_path.mkdir()
                stack.callback(shutil.rmtree, workspace_path)
                workspace=str(workspace_path)
                session_id='migration-' + 'a' * 64
                summary_attempts=[]
                async with AsyncOpenAI(api_key='fixture-key',base_url='https://fixture.invalid/v1',
                        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                    async def create_session():
                        model=init_model('OpenAI','fixture','fixture-key','https://fixture.invalid/v1')
                        model._client._create_async_openai_client=lambda timeout=None:client
                        rail=TaskContextProcessorRail(preset=True,processors=[('SessionMemoryCompressor',{
                            'enabled':True,'trigger_context_ratio':0.1,
                            'memory':{'update_trigger_context_ratio':0.05}})])
                        config=ContextEngineConfig(model_name='fixture',context_window_tokens=4096,enable_reload=True,
                            compression_recall_config=CompressionRecallConfig(enabled=True))
                        agent=native_test_agent(model,card=task_agent_card(),system_prompt='完成迁移任务',tools=[],workspace=workspace,
                            rails=[rail],context_engine_config=config,enable_task_loop=False,
                            enable_read_image_multimodal=False,auto_create_workspace=False,prompt_mode='minimal')
                        session=TaskAgentSession(agent,session_id,Activity())
                        await session._start()
                        async def summarize(**kwargs):
                            summary_attempts.append(True)
                            if len(summary_attempts)==1:
                                raise RuntimeError('simulated summary failure')
                            Path(kwargs['notes_path']).write_text('用户要求：保留权限审计；目标：迁移会议室工具。',encoding='utf-8')
                        rail._session_memory_mgr._update_agent.invoke=summarize
                        return session,rail

                    session,rail=await create_session()
                    try:
                        await session.run('用户要求：保留权限审计 auditmarker927。' + '会议室迁移材料' * 300)
                        await session.run('请继续检查迁移目标。')
                        for _ in range(100):
                            if summary_attempts and not rail._session_memory_mgr._tasks: break
                            await asyncio.sleep(.05)
                        self.assertEqual(len(summary_attempts),1)
                        await session.run('总结失败后请保留原始要求。')
                        self.assertIn('auditmarker927',json.dumps(calls[-1],ensure_ascii=False))
                        for _ in range(100):
                            tasks=list(rail._session_memory_mgr._tasks.values())
                            notes=list(Path(root).rglob('session_context.md'))
                            if len(summary_attempts)>1 and notes and not tasks: break
                            await asyncio.sleep(.05)
                        self.assertGreaterEqual(len(summary_attempts),2)
                        self.assertTrue(notes, 'framework did not persist session memory')
                        self.assertIn('保留权限审计',notes[0].read_text(encoding='utf-8'))
                        with patch('openjiuwen.core.context_engine.processor.forked.compressor.recall.archive_compression_messages',
                                   side_effect=OSError('simulated archive failure')):
                            await session.run('归档不可用时继续检查。')
                        self.assertEqual([event[0] for event in session.activity.events].count('warning'),1)
                        self.assertIn('已保留原始内容',session.activity.events[-1][1])
                        self.assertIn('auditmarker927',json.dumps(calls[-1],ensure_ascii=False))
                        self.assertNotIn('<memory_block_session>',json.dumps(calls[-1],ensure_ascii=False))
                        await session.run('确认后续步骤。')
                        self.assertIn('<memory_block_session>',json.dumps(calls[-1],ensure_ascii=False))
                        self.assertIn('保留权限审计',json.dumps(calls[-1],ensure_ascii=False))
                        archives=list(Path(workspace).rglob('raw_messages.json'))
                        self.assertTrue(archives, 'compressed messages were not archived for recall')
                        self.assertIn('保留权限审计',archives[0].read_text(encoding='utf-8'))
                    finally:
                        await session.close()
                    restored,_=await create_session()
                    try:
                        await restored.run('继续原任务。')
                        self.assertIn('<memory_block_session>',json.dumps(calls[-1],ensure_ascii=False))
                        self.assertIn('保留权限审计',json.dumps(calls[-1],ensure_ascii=False))
                        recalled=recall_compressed_context(workspace_dir=workspace,session_id=session_id,query='auditmarker927')
                        self.assertIn('auditmarker927',json.dumps(recalled['chunks'],ensure_ascii=False))
                    finally:
                        await restored.close()
                checkpointer = None
        finally:
            if checkpointer is not None:
                await checkpointer._kv_store.engine.dispose()
            CheckpointerFactory.set_default_checkpointer(previous)

    async def test_task_session_pauses_and_continues_same_native_round(self):
        import httpx
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm.model import init_model
        from .agent_session import TaskAgentSession
        from .agent_conversation_store import ConversationStore

        started = asyncio.Event()
        calls = []
        async def respond(request):
            calls.append(json.loads(request.content))
            if len(calls) == 1:
                started.set()
                await asyncio.Event().wait()
            chunk = {'id':'fixture','object':'chat.completion.chunk','created':0,'model':'fixture',
                'choices':[{'index':0,'delta':{'role':'assistant','content':'继续完成'},'finish_reason':'stop'}]}
            return httpx.Response(200,headers={'content-type':'text/event-stream'},
                                  text='data: '+json.dumps(chunk,ensure_ascii=False)+'\n\ndata: [DONE]\n\n')
        class Activity:
            response = ''
            def delta(self, text): self.response += text
            def send(self, *_args): pass
        with tempfile.TemporaryDirectory() as root:
            async with AsyncOpenAI(api_key='fixture-key',base_url='https://fixture.invalid/v1',
                    http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                model=init_model('OpenAI','fixture','fixture-key','https://fixture.invalid/v1')
                model._client._create_async_openai_client=lambda timeout=None:client
                agent=native_test_agent(model,system_prompt='完成任务',tools=[],workspace=root,enable_task_loop=False,
                    enable_read_image_multimodal=False,auto_create_workspace=False,prompt_mode='minimal')
                store=ConversationStore(root);await store.initialize()
                session=TaskAgentSession(agent,'warm-pause-test',Activity(),store,'attempt-warm')
                try:
                    running=asyncio.create_task(session.run('完成任务'))
                    await asyncio.wait_for(started.wait(),30)
                    self.assertTrue(await asyncio.wait_for(session.pause(),15))
                    self.assertFalse(running.done())
                    self.assertEqual((await store.paused_round('warm-pause-test','attempt-warm'))['status'],'paused')
                    self.assertTrue(await session.resume(['继续时保留现有接口']))
                    self.assertEqual((await store.paused_round('warm-pause-test','attempt-warm'))['status'],'resumed')
                    result=await asyncio.wait_for(running,30)
                    self.assertIn('继续完成',result['output'])
                    self.assertEqual(len(calls),2)
                    self.assertIn('继续时保留现有接口',json.dumps(calls[-1]['messages'],ensure_ascii=False))
                finally:
                    await session.close()

    async def test_main_agent_discovers_and_reads_runtime_preparation_skill(self):
        import io
        import httpx
        from pathlib import Path
        from unittest.mock import MagicMock, patch
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm.model import init_model
        from openjiuwen.core.sys_operation import SysOperation
        from openjiuwen.core.sys_operation.base import OperationMode
        from openjiuwen.core.sys_operation.config import LocalWorkConfig
        from openjiuwen.core.sys_operation.sys_operation import SysOperationCard
        from .agent_execution import assemble_agent
        from .agent_session import TaskAgentSession

        calls = []
        async def respond(request):
            body = json.loads(request.content)
            calls.append(body)
            if len(calls) <= 2:
                name = 'list_skill' if len(calls) == 1 else 'skill_tool'
                arguments = {} if len(calls) == 1 else {'skill_name': 'runtime-preparation'}
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': f'skill-{len(calls)}', 'type': 'function',
                    'function': {'name': name, 'arguments': json.dumps(arguments)}}]}
                finish = 'tool_calls'
            else:
                delta = {'role': 'assistant', 'content': '已读取运行准备指导。'}
                finish = 'stop'
            chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'fixture',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                  text='data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\ndata: [DONE]\n\n')

        skill_root = Path(__file__).resolve().parents[2] / 'src' / 'resources' / 'agents' / 'v1' / 'skills'
        with tempfile.TemporaryDirectory() as root:
            async with AsyncOpenAI(api_key='fixture-key', base_url='https://fixture.invalid/v1',
                    http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                model = init_model('OpenAI', 'fixture', 'fixture-key', 'https://fixture.invalid/v1')
                model._client._create_async_openai_client = lambda timeout=None: client
                operation = SysOperation(SysOperationCard(id='skill-discovery-test', mode=OperationMode.LOCAL,
                    work_config=LocalWorkConfig(restrict_to_sandbox=True, sandbox_root=[root, str(skill_root)], shell_allowlist=[])))
                composition = MagicMock()
                composition.definition = {'modelRole': 'MIGRATION'}
                composition.receipt.return_value = {'resources': [], 'definitionDigest': 'fixture'}
                with patch('openjiuwen.core.foundation.llm.init_model', return_value=model):
                    agent, _, activity, _ = assemble_agent(composition=composition, body={},
                        bound={'apiKey': 'fixture-key', 'baseUrl': 'https://fixture.invalid/v1', 'supportsTools': True},
                        settings={'model_name': 'fixture'}, workspace=Path(root), operation=operation,
                        tools=[], protocol=io.StringIO(), trace=[], kind='deep', task_session={'skill_roots': [str(skill_root)]})
                session = TaskAgentSession(agent, 'skill-discovery-test', activity)
                try:
                    result = await asyncio.wait_for(session.run('准备完整工程'), timeout=45)
                    self.assertIn('已读取运行准备指导', result['output'])
                    listing = json.dumps(calls[1]['messages'], ensure_ascii=False)
                    self.assertIn('runtime-preparation', listing)
                    self.assertIn('调查并准备完整 Agent 工程', listing)
                    self.assertNotIn('Skill located in', listing)
                    loaded = json.dumps(calls[2]['messages'], ensure_ascii=False)
                    self.assertIn('正式 Agent 基线必须经过原 Agent 的实际入口', loaded)
                finally:
                    await session.close()

    async def test_main_agent_delegates_to_an_isolated_native_investigator(self):
        import io
        import httpx
        from pathlib import Path
        from unittest.mock import MagicMock, patch
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm.model import init_model
        from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
        from openjiuwen.core.sys_operation import SysOperation
        from openjiuwen.core.sys_operation.base import OperationMode
        from openjiuwen.core.sys_operation.config import LocalWorkConfig
        from openjiuwen.core.sys_operation.sys_operation import SysOperationCard
        from .agent_execution import assemble_agent
        from .agent_session import TaskAgentSession
        from .development_evidence import build_evaluation_evidence_tool
        from .delivery_review_snapshot import DeliveryReviewSnapshots

        calls = []
        async def respond(request):
            body = json.loads(request.content)
            calls.append(body)
            messages = json.dumps(body['messages'], ensure_ascii=False)
            if '你是候选效果的只读审查者' in messages:
                delta = {'role': 'assistant', 'content': '材料不足，建议补充独立评测。'}
                finish = 'stop'
            elif '你是迁移交付的独立只读审查者' in messages:
                tool_count = sum(message.get('role') == 'tool' for message in body['messages'])
                if tool_count == 0:
                    delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'delivery-read', 'type': 'function',
                        'function': {'name': 'read_file', 'arguments': '{"file_path":"candidate/tool.py"}'}}]}
                    finish = 'tool_calls'
                elif tool_count == 1:
                    delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'delivery-evidence', 'type': 'function',
                        'function': {'name': 'query_development_evaluations', 'arguments': '{"run_id":"development-1"}'}}]}
                    finish = 'tool_calls'
                elif tool_count == 2:
                    delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'delivery-checks', 'type': 'function',
                        'function': {'name': 'query_project_checks', 'arguments': '{}'}}]}
                    finish = 'tool_calls'
                elif tool_count == 3:
                    delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'delivery-record', 'type': 'function',
                        'function': {'name': 'record_delivery_review', 'arguments': json.dumps({'decision':'RECOMMEND',
                            'summary':'源码已核对，仍需运行验证', 'citations':[{'path':'candidate/tool.py','quote':'实际候选证据'}],
                            'basic_review':{'status':'SUFFICIENT','scope':'启动检查','reason':'命令通过','coversTaskScope':True,
                                'references':[{'kind':'project_check','id':'project-check-fixture'}]}}, ensure_ascii=False)}}]}
                    finish = 'tool_calls'
                else:
                    delta = {'role': 'assistant', 'content': '已独立核对源码，仍需运行验证。'}
                    finish = 'stop'
            elif '你是迁移任务的只读调查者' in messages:
                if not any(message.get('role') == 'tool' for message in body['messages']):
                    delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'read-1', 'type': 'function',
                        'function': {'name': 'read_file', 'arguments': '{"file_path":"candidate/tool.py"}'}}]}
                    finish = 'tool_calls'
                else:
                    delta = {'role': 'assistant', 'content': '依据材料，建议核对工具输入。'}
                    finish = 'stop'
            elif not any(message.get('role') == 'tool' for message in body['messages']):
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'delegate-1', 'type': 'function',
                    'function': {'name': 'task_tool', 'arguments': json.dumps({
                        'subagent_type': 'migration_investigator', 'task_description': '检查工具输入的证据'}, ensure_ascii=False)}}]}
                finish = 'tool_calls'
            elif sum(message.get('role') == 'tool' for message in body['messages']) == 1:
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'delegate-2', 'type': 'function',
                    'function': {'name': 'task_tool', 'arguments': json.dumps({
                        'subagent_type': 'review_advisor', 'task_description': '核查冻结评测证据'}, ensure_ascii=False)}}]}
                finish = 'tool_calls'
            elif sum(message.get('role') == 'tool' for message in body['messages']) == 2:
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'delegate-3', 'type': 'function',
                    'function': {'name': 'task_tool', 'arguments': json.dumps({
                        'subagent_type': 'migration_delivery_reviewer', 'task_description': '独立核查交付源码'}, ensure_ascii=False)}}]}
                finish = 'tool_calls'
            else:
                delta = {'role': 'assistant', 'content': '已取得调查建议。'}
                finish = 'stop'
            if not body.get('stream'):
                return httpx.Response(200, json={'id': 'fixture', 'object': 'chat.completion', 'created': 0,
                    'model': 'fixture', 'choices': [{'index': 0, 'message': delta, 'finish_reason': finish}]})
            chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'fixture',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                  text='data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\ndata: [DONE]\n\n')

        with tempfile.TemporaryDirectory() as root:
            (Path(root) / 'candidate').mkdir()
            (Path(root) / 'candidate' / 'tool.py').write_text('实际候选证据', encoding='utf-8')
            (Path(root) / 'task').mkdir()
            (Path(root) / 'task' / 'manifest.json').write_text('{}', encoding='utf-8')
            async with AsyncOpenAI(api_key='fixture-key', base_url='https://fixture.invalid/v1',
                    http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                model = init_model('OpenAI', 'fixture', 'fixture-key', 'https://fixture.invalid/v1')
                model._client._create_async_openai_client = lambda timeout=None: client
                operation = SysOperation(SysOperationCard(id='subagent-test', mode=OperationMode.LOCAL,
                    work_config=LocalWorkConfig(restrict_to_sandbox=True, sandbox_root=[root], shell_allowlist=[])))
                composition = MagicMock()
                composition.definition = {'modelRole': 'MIGRATION'}
                composition.receipt.return_value = {'resources': [], 'definitionDigest': 'fixture'}
                async def read_file(file_path):
                    return {'path': file_path, 'content': '实际候选证据'}
                read_tool = LocalFunction(ToolCard(id='test-read', name='read_file', description='只读文件',
                    input_params={'type': 'object', 'properties': {'file_path': {'type': 'string'}},
                                  'required': ['file_path']}), read_file)
                evidence_tool = build_evaluation_evidence_tool([{'runId':'development-1','status':'PASSED',
                    'candidateDigest':'current','cases':[{'caseId':'visible-development-case'}]}], lambda:'current')
                with patch('openjiuwen.core.foundation.llm.init_model', return_value=model):
                    agent, _, activity, _ = assemble_agent(composition=composition, body={},
                        bound={'apiKey': 'fixture-key', 'baseUrl': 'https://fixture.invalid/v1', 'supportsTools': True},
                        settings={'model_name': 'fixture'}, workspace=Path(root), operation=operation,
                        tools=[read_tool], protocol=io.StringIO(), trace=[], kind='deep', task_session={'skill_roots': [root]},
                        session_tools=[evidence_tool])
                class Store:
                    def __init__(self): self.events = []
                    async def append(self, _session, _key, kind, payload): self.events.append((kind, payload))
                store = Store()
                activity.attach_conversation(store, 'native-delegation-test', candidate_digest=lambda:'current')
                from assets.snapshot import files_digest
                import base64
                digest=files_digest({'tool.py':base64.b64encode('实际候选证据'.encode()).decode()})
                checks=[{'receiptId':'project-check-fixture','snapshotDigest':digest,'status':'COMPLETED','exitCode':0}]
                snapshots=DeliveryReviewSnapshots(agent, Path(root), {}, [{'runId':'development-1','status':'PASSED',
                    'candidateDigest':'current','cases':[{'caseId':'visible-development-case'}]}], checks)
                activity.attach_review_snapshots(snapshots)
                session = TaskAgentSession(agent, 'native-delegation-test', activity)
                try:
                    result = await asyncio.wait_for(session.run('主会话私有标记 PRIVATE-PARENT-MARKER'), timeout=45)
                    self.assertIn('已取得调查建议', result['output'])
                    child = next(call for call in calls if '你是迁移任务的只读调查者' in json.dumps(call['messages'], ensure_ascii=False))
                    child_messages = json.dumps(child['messages'], ensure_ascii=False)
                    self.assertIn('检查工具输入的证据', child_messages)
                    self.assertNotIn('PRIVATE-PARENT-MARKER', child_messages)
                    child_followup = next(call for call in calls if '你是迁移任务的只读调查者' in json.dumps(call['messages'], ensure_ascii=False)
                                          and any(message.get('role') == 'tool' for message in call['messages']))
                    self.assertIn('实际候选证据', json.dumps(child_followup['messages'], ensure_ascii=False))
                    child_tools = json.dumps(child.get('tools', []), ensure_ascii=False)
                    self.assertNotIn('write_file', child_tools)
                    self.assertNotIn('bash', child_tools)
                    review = next(call for call in calls if '你是候选效果的只读审查者' in json.dumps(call['messages'], ensure_ascii=False))
                    review_messages = json.dumps(review['messages'], ensure_ascii=False)
                    self.assertIn('核查冻结评测证据', review_messages)
                    self.assertNotIn('PRIVATE-PARENT-MARKER', review_messages)
                    self.assertNotIn('依据材料，建议核对工具输入', review_messages)
                    self.assertNotIn('read_file', json.dumps(review.get('tools', []), ensure_ascii=False))
                    delivery = next(call for call in calls if '你是迁移交付的独立只读审查者' in json.dumps(call['messages'], ensure_ascii=False)
                                    and any(message.get('role') == 'tool' for message in call['messages']))
                    self.assertIn('实际候选证据', json.dumps(delivery['messages'], ensure_ascii=False))
                    self.assertNotIn('PRIVATE-PARENT-MARKER', json.dumps(delivery['messages'], ensure_ascii=False))
                    delivery_tools = json.dumps(delivery.get('tools', []), ensure_ascii=False)
                    self.assertIn('read_file', delivery_tools)
                    self.assertNotIn('write_file', delivery_tools)
                    self.assertNotIn('bash', delivery_tools)
                    delivery_evidence = next(call for call in calls if '你是迁移交付的独立只读审查者' in json.dumps(call['messages'], ensure_ascii=False)
                                             and 'visible-development-case' in json.dumps(call['messages'], ensure_ascii=False))
                    self.assertIn('query_development_evaluations', json.dumps(delivery_evidence.get('tools', []), ensure_ascii=False))
                    self.assertIn('交付审查 · 调用工具：read_file', activity.protocol.getvalue())
                    await activity.flush()
                    self.assertTrue(any(kind == 'work_product' and payload['id'] == 'independent-delivery-review'
                                        and '仍需运行验证' in payload['content'] and payload['reviewStability']=='frozen'
                                        and len(payload['workspaceDigest'])==64 for kind, payload in store.events))
                    self.assertTrue(any(kind == 'delivery_review' and payload['decision']=='RECOMMEND'
                                        and payload['citations'][0]['quote']=='实际候选证据'
                                        and payload.get('basicReview',{}).get('status')=='SUFFICIENT'
                                        and payload['basicReview'].get('coversTaskScope') is True for kind,payload in store.events))
                    self.assertFalse(snapshots.active)
                finally:
                    await session.close()

    async def test_large_tool_output_is_offloaded_to_the_session_workspace(self):
        import httpx
        from pathlib import Path
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm.model import init_model
        from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
        from openjiuwen.core.context_engine.schema.config import ContextEngineConfig, CompressionRecallConfig
        from openjiuwen.harness.rails.context_engineer import ContextProcessorRail
        from .agent_session import TaskAgentSession

        calls = []
        long_output = 'unique-business-evidence-' * 800
        async def respond(request):
            calls.append(json.loads(request.content))
            if len(calls) == 1:
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'large-1', 'type': 'function',
                    'function': {'name': 'large_result', 'arguments': '{}'}}]}
                finish = 'tool_calls'
            else:
                delta = {'role': 'assistant', 'content': '已读取结果'}
                finish = 'stop'
            chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'fixture',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                  text='data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\ndata: [DONE]\n\n')

        async def large_result():
            return long_output

        with tempfile.TemporaryDirectory() as root:
            async with AsyncOpenAI(api_key='fixture-key', base_url='https://fixture.invalid/v1',
                    http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                model = init_model('OpenAI', 'fixture', 'fixture-key', 'https://fixture.invalid/v1')
                model._client._create_async_openai_client = lambda timeout=None: client
                tool = LocalFunction(ToolCard(id='large-result', name='large_result', description='读取大结果',
                    input_params={'type': 'object', 'properties': {}}), large_result)
                rail = ContextProcessorRail(preset=True, processors=[('SessionMemoryCompressor', {'enabled': True})])
                config = ContextEngineConfig(model_name='fixture', context_window_tokens=4096, enable_reload=True,
                                             compression_recall_config=CompressionRecallConfig(enabled=True))
                agent = native_test_agent(model, tools=[tool], workspace=root, rails=[rail], context_engine_config=config,
                    enable_task_loop=False, enable_read_image_multimodal=False, auto_create_workspace=False, prompt_mode='minimal')
                class Activity:
                    def delta(self, _text):
                        pass
                session = TaskAgentSession(agent, 'offload-test', Activity())
                try:
                    result = await asyncio.wait_for(session.run('读取结果'), timeout=30)
                    self.assertIn('已读取结果', result['output'])
                    self.assertGreaterEqual(len(calls), 2)
                    self.assertIn('[[OFFLOAD:', json.dumps(calls[1], ensure_ascii=False))
                    archives = list((Path(root) / 'context').rglob('MessageSummaryOffloader_*.json'))
                    self.assertTrue(archives)
                    self.assertIn(long_output, archives[0].read_text(encoding='utf-8'))
                finally:
                    await session.close()

    async def test_native_steer_is_seen_during_current_task(self):
        import httpx
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm.model import init_model
        from openjiuwen.core.foundation.tool import LocalFunction, ToolCard
        from openjiuwen.core.single_agent.schema.agent_card import AgentCard
        from .agent_session import TaskAgentSession

        requested = asyncio.Event()
        release = asyncio.Event()
        calls = []

        async def respond(request):
            calls.append(json.loads(request.content))
            if len(calls) == 1:
                requested.set()
                await release.wait()
                delta = {'role': 'assistant', 'tool_calls': [{'index': 0, 'id': 'check-1', 'type': 'function',
                    'function': {'name': 'check_source', 'arguments': '{}'}}]}
                finish = 'tool_calls'
            else:
                delta = {'role': 'assistant', 'content': '已完成检查。'}
                finish = 'stop'
            chunk = {'id': 'fixture', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'fixture',
                     'choices': [{'index': 0, 'delta': delta, 'finish_reason': finish}]}
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                                  text='data: ' + json.dumps(chunk, ensure_ascii=False) + '\n\ndata: [DONE]\n\n')

        async def check_source():
            return {'checked': True}

        with tempfile.TemporaryDirectory() as root:
            async with AsyncOpenAI(api_key='fixture-key', base_url='https://fixture.invalid/v1',
                    http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                model = init_model('OpenAI', 'fixture', 'fixture-key', 'https://fixture.invalid/v1')
                model._client._create_async_openai_client = lambda timeout=None: client
                card = AgentCard(id='live-session-test', name='live-session-test', description='test')
                tool = LocalFunction(ToolCard(id='live-check', name='check_source', description='检查源码',
                    input_params={'type': 'object', 'properties': {}}), check_source)
                agent = native_test_agent(model, card=card, tools=[tool], workspace=root,
                    enable_task_loop=False, enable_read_image_multimodal=False,
                    auto_create_workspace=False, prompt_mode='minimal')
                class Activity:
                    def delta(self, _text):
                        pass
                session = TaskAgentSession(agent, 'live-session-test', Activity())
                try:
                    collected = asyncio.create_task(session.run('开始检查'))
                    await asyncio.wait_for(requested.wait(), timeout=15)
                    await session.steer('保留原有服务接口', 'steer')
                    release.set()
                    result = await asyncio.wait_for(collected, timeout=30)
                    self.assertIn('已完成检查', result['output'])
                    self.assertGreaterEqual(len(calls), 2)
                    self.assertIn('保留原有服务接口', json.dumps(calls[1], ensure_ascii=False))
                finally:
                    release.set()
                    await session.close()
