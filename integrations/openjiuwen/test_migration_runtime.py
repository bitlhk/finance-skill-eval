import asyncio
import json
import os
import socket
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx

from integrations.openjiuwen.migration_runtime import MigrationHandler, PoolHandler, create_migration_runtime


class MigrationRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_instance_failure_is_confirmed_without_forwarding_raw_error(self):
        from agent_runtime.domain.context import ServeRequest
        from tempfile import TemporaryDirectory
        class Pool:
            async def stream(self,*_args):
                yield {'error':'private task credentials','errorType':'ValueError'}
        with TemporaryDirectory() as root, patch.dict(os.environ,{'FINANCE_EVAL_DATA_DIR':root}):
            handler=PoolHandler();handler.pool=Pool()
            request=ServeRequest.of_text('运行',conversation_id='task',metadata={ServeRequest.REQUEST_BODY_META_KEY:{
                'executionId':'failure','payload':{'checkpointRoot':root,'correlation':{'taskId':'task','attemptId':'attempt'},'taskSession':{}}}})
            records=[item.data['record'] async for item in handler.stream_query(request)]
            self.assertEqual(handler.relay.state('task','failure'),'completed')
            self.assertEqual(records,[{'result':{'status':'FAILED','error':'Agent 实例执行失败（ValueError）'}}])
            self.assertNotIn('private',str(records))
            await handler.relay.close()

    async def test_rejects_wrong_workspace_as_confirmed_failure_before_allocating_instance(self):
        from agent_runtime.domain.context import ServeRequest
        from tempfile import TemporaryDirectory
        class Pool:
            async def stream(self,*_args):
                raise AssertionError('wrong workspace must not start an Agent')
                yield
        handler=PoolHandler()
        handler.pool=Pool()
        with TemporaryDirectory() as allowed, TemporaryDirectory() as outside, patch.dict(os.environ,{'FINANCE_EVAL_DATA_DIR':allowed}):
            request=ServeRequest.of_text('运行',conversation_id='task',metadata={ServeRequest.REQUEST_BODY_META_KEY:{
                'executionId':'execution','payload':{'checkpointRoot':outside,'correlation':{'taskId':'task','attemptId':'attempt'},'taskSession':{}}}})
            records=[item.data['record'] async for item in handler.stream_query(request)]
        self.assertEqual(len(records),1)
        self.assertEqual(records[0]['result']['status'],'FAILED')
        self.assertIn('FINANCE_EVAL_DATA_DIR',records[0]['result']['error'])
        self.assertNotIn(outside,records[0]['result']['error'])

    async def test_wrong_workspace_failure_reaches_runtime_http_stream(self):
        from tempfile import TemporaryDirectory
        handler=PoolHandler()
        with TemporaryDirectory() as allowed, TemporaryDirectory() as outside, patch.dict(os.environ,{'FINANCE_EVAL_DATA_DIR':allowed}):
            transport=httpx.ASGITransport(app=create_migration_runtime(handler),client=('127.0.0.1',1234))
            token=os.environ.get('FINANCE_EVAL_ACCESS_TOKEN','').strip()
            headers={'Authorization':'Bearer '+token} if token else {}
            async with httpx.AsyncClient(transport=transport,base_url='http://runtime',headers=headers) as client:
                response=await client.post('/v1/project/agents/migration/conversations/task',json={
                    'input':{'query':'运行'},'stream':True,'executionId':'execution',
                    'payload':{'checkpointRoot':outside,'correlation':{'taskId':'task','attemptId':'attempt'},'taskSession':{}}})
        self.assertEqual(response.status_code,200)
        self.assertIn('FINANCE_EVAL_DATA_DIR',response.text)
        self.assertNotIn(outside,response.text)

    async def test_review_executes_in_python_without_model_exchange(self):
        from agent_runtime.domain.context import ServeRequest
        events = []
        async def run_role(body, output):
            self.assertEqual(body['payload'], {'goal': 'frozen evidence'})
            output.write(json.dumps({'type': 'result', 'content': 'reviewed'}) + '\n')
        async def unused(*_args):
            raise AssertionError('review should not execute migration')
        handler = MigrationHandler(unused)
        request = ServeRequest.of_text('审查', conversation_id='task-1', metadata={ServeRequest.REQUEST_BODY_META_KEY: {
            'payload': {'taskSession': {}, 'correlation': {'taskId': 'task-1', 'attemptId': 'attempt-1'},
                        'roleCall': {'role': 'effect-review', 'timeoutMs': 5000, 'payload': {'goal': 'frozen evidence'}}}}})
        with patch('integrations.openjiuwen.model_role_agent.run', run_role):
            async for item in handler.stream_query(request):
                events.append(item.data['record'])
        self.assertEqual(events, [{'type': 'result', 'content': 'reviewed'}])
        self.assertFalse(hasattr(handler, 'model_response'))
    async def test_cancel_review_waits_for_runtime_worker_to_stop(self):
        from agent_runtime.domain.context import ServeRequest
        model_waiting=asyncio.Event()
        stopped=asyncio.Event()
        async def run_role(_body, _output):
            try:
                model_waiting.set()
                await asyncio.Future()
            finally:
                stopped.set()
        async def unused(*_args): pass
        handler=MigrationHandler(unused)
        request=ServeRequest.of_text('审查',conversation_id='task-1',metadata={ServeRequest.REQUEST_BODY_META_KEY:{
            'payload':{'taskSession':{},'correlation':{'taskId':'task-1','attemptId':'attempt-1'},
                       'roleCall':{'role':'effect-review','timeoutMs':5000}}}})
        async def collect():
            async for _item in handler.stream_query(request): pass
        with patch('integrations.openjiuwen.model_role_agent.run', run_role):
            running=asyncio.create_task(collect())
            await asyncio.wait_for(model_waiting.wait(),3)
            self.assertFalse(await handler.cancel('task-1','wrong'))
            self.assertTrue(await handler.cancel('task-1','attempt-1'))
            self.assertTrue(stopped.is_set())
            with self.assertRaises(asyncio.CancelledError): await running

    async def test_pause_and_resume_are_routed_to_the_active_attempt(self):
        ready, release = asyncio.Event(), asyncio.Event()
        controls_seen = []
        class Session:
            async def pause(self): controls_seen.append('pause'); return True
            async def resume(self, instructions=()): controls_seen.append(('resume',list(instructions))); return True
            async def control_state(self): return 'PAUSED'
        async def run(_payload, output, controls):
            controls.start(Session());ready.set();await release.wait()
            output.write(json.dumps({'result': {'status': 'PRODUCED'}}) + '\n')
            await controls.close()
        handler = MigrationHandler(run)
        app = create_migration_runtime(handler)
        token = os.environ.get('FINANCE_EVAL_ACCESS_TOKEN', '').strip()
        headers = {'Authorization': 'Bearer ' + token} if token else {}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://runtime', headers=headers) as client:
            running = asyncio.create_task(client.post('/v1/project/agents/migration/conversations/task-1', json={
                'input': {'query':'工作'}, 'stream':True,
                'payload': {'taskSession':{}, 'correlation':{'taskId':'task-1','attemptId':'attempt-1'}}}))
            await asyncio.wait_for(ready.wait(), 3)
            self.assertEqual((await client.post('/internal/migration/task-1/pause/wrong')).status_code, 409)
            self.assertEqual((await client.post('/internal/migration/task-1/pause/attempt-1')).status_code, 200)
            self.assertEqual((await client.get('/internal/migration/task-1/control-state/attempt-1')).json()['state'], 'PAUSED')
            self.assertEqual((await client.get('/internal/migration/task-1/control-state/wrong')).json()['state'], 'UNAVAILABLE')
            self.assertEqual((await client.post('/internal/migration/task-1/resume/attempt-1',json={'instructions':['先核对权限']})).status_code, 200)
            release.set();self.assertEqual((await running).status_code, 200)
        self.assertEqual(controls_seen, ['pause',('resume',['先核对权限'])])

    async def test_http_disconnect_reattaches_to_same_runtime_execution(self):
        import uvicorn
        from tempfile import TemporaryDirectory
        from .execution_relay import ExecutionRelay
        release = asyncio.Event()
        calls = []

        class Pool:
            async def start(self):
                pass
            async def stop(self):
                pass
            async def stream(self, session_id, request_id, payload):
                calls.append((session_id, request_id))
                yield {'record': {'activity': {'kind': 'progress', 'label': '开始'}}}
                await release.wait()
                yield {'record': {'result': {'status': 'PRODUCED'}}}

        handler=PoolHandler()
        journal=TemporaryDirectory()
        self.addCleanup(journal.cleanup)
        handler.relay=ExecutionRelay(journal_root=journal.name)
        handler.pool=Pool()
        app=create_migration_runtime(handler)
        listener=socket.socket()
        listener.bind(('127.0.0.1',0))
        listener.listen(128)
        port=listener.getsockname()[1]
        server=uvicorn.Server(uvicorn.Config(app,log_level='warning',lifespan='on',timeout_graceful_shutdown=2))
        server_task=asyncio.create_task(server.serve(sockets=[listener]))
        token=os.environ.get('FINANCE_EVAL_ACCESS_TOKEN','').strip()
        headers={'Authorization':'Bearer '+token} if token else {}
        try:
            for _ in range(200):
                if server.started:
                    break
                await asyncio.sleep(.05)
            self.assertTrue(server.started)
            async with httpx.AsyncClient(base_url=f'http://127.0.0.1:{port}',headers=headers,timeout=5,trust_env=False) as client:
                async with client.stream('POST','/v1/project/agents/migration/conversations/task-1',json={
                    'input':{'query':'开始'},'stream':True,'executionId':'execution-1',
                    'payload':{'checkpointRoot':os.environ.get('FINANCE_EVAL_DATA_DIR') or os.path.join(os.getcwd(),'data'),
                               'taskSession':{},'correlation':{'taskId':'task-1','attemptId':'attempt-1'}}}) as response:
                    self.assertEqual(response.status_code,200)
                    lines=response.aiter_lines()
                    line=await asyncio.wait_for(anext(lines),5)
                    self.assertIn('开始',line)
                release.set()
                result=await client.get('/internal/migration/task-1/execution/execution-1?after=1')
                self.assertEqual(result.status_code,200)
                self.assertIn('PRODUCED',result.text)
                self.assertEqual(calls,[('task-1','execution-1')])
        finally:
            release.set()
            server.should_exit=True
            await asyncio.wait_for(server_task,10)

    async def test_runtime_rest_handler_forwards_activity_and_native_steering(self):
        ready = asyncio.Event()
        received = asyncio.Event()
        instructions = []

        class Session:
            async def steer(self, text, request_id):
                instructions.append((text, request_id))
                received.set()

        async def run(payload, output, controls):
            controls.start(Session())
            output.write(json.dumps({'activity': {'kind': 'progress', 'label': '准备'}}) + '\n')
            ready.set()
            await asyncio.wait_for(received.wait(), 3)
            output.write(json.dumps({'result': {'status': 'PRODUCED'}}) + '\n')
            await controls.close()

        handler = MigrationHandler(run)
        app = create_migration_runtime(handler)
        token = os.environ.get('FINANCE_EVAL_ACCESS_TOKEN', '').strip()
        headers = {'Authorization': 'Bearer ' + token} if token else {}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://runtime', headers=headers) as client:
            request = asyncio.create_task(client.post('/v1/project/agents/migration/conversations/task-1', json={
                'input': {'query': '准备工程'}, 'stream': True,
                'payload': {'taskSession': {}, 'correlation': {'taskId': 'task-1', 'attemptId': 'attempt-1'}},
            }))
            await asyncio.wait_for(ready.wait(), 3)
            with self.assertRaises(RuntimeError):
                await handler.steer('task-1', 'wrong-attempt', 'request-1', '补充')
            await handler.steer('task-1', 'attempt-1', 'request-1', '补充')
            response = await request
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(instructions, [('补充', 'request-1')])
        self.assertIn('PRODUCED', response.text)
        self.assertIn('activity', response.text)


if __name__ == '__main__':
    unittest.main()
