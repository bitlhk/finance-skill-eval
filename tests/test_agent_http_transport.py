import json
import unittest

import httpx

from runtime.agent_client import AgentRuntimeClient, MigrationAgentUnavailable
from runtime.transport import RemoteError, sse_events


class EngineeringTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_complete_project_result_exceeds_business_event_limit(self):
        files = {'uv.lock': 'x' * 600000, 'skills/example/SKILL.md': 'original'}
        result = {'status': 'PRODUCED', 'files': files, 'payload': {'message': 'Read full project'}}
        transport = httpx.MockTransport(lambda request: httpx.Response(200,
            headers={'content-type': 'text/event-stream'}, content='data: ' + json.dumps({'result': result}) + '\n\n'))
        client = AgentRuntimeClient('http://runtime', transport=transport)
        actual = await client.execute({'taskSession': {'executionId': 'execution'}}, 'project')
        self.assertEqual(actual, result)

    async def test_business_stream_remains_bounded(self):
        response = httpx.Response(200, content='data: ' + json.dumps({'output': 'x' * 600000}) + '\n\n')
        with self.assertRaisesRegex(RemoteError, 'SSE frame exceeds'):
            async for _ in sse_events(response):
                pass

    async def test_lost_runtime_transport_stays_recoverable(self):
        transport = httpx.MockTransport(lambda request: httpx.Response(502))
        client = AgentRuntimeClient('http://runtime', transport=transport)
        with self.assertRaises(MigrationAgentUnavailable):
            await client.execute({'taskSession': {'executionId': 'execution'}}, 'project')
