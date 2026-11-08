import asyncio
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations' / 'openjiuwen'))
from evaluation_process import EvaluationProcess


class ProcessTests(unittest.IsolatedAsyncioTestCase):
    async def test_launcher_capacity_is_retryable_after_an_instance_is_released(self):
        import hashlib
        from httpx import ASGITransport, AsyncClient
        from integrations.openjiuwen import worker
        from integrations.openjiuwen.instance_manager import InstanceManager

        request = {
            'schemaVersion': 'finance.runtime-instance.v1', 'runId': 'capacity-test',
            'side': 'right', 'modelId': 'test-model', 'environment': {}, 'configuration': {},
            'secrets': {'mode': 'inline', 'values': {}}, 'limits': {'timeoutMs': 10000},
            'skills': [], 'contentDigest': hashlib.sha256(b'').hexdigest(),
        }
        route = '/v1/runtime-instances'
        with patch.object(worker, 'instances', InstanceManager()), patch.object(
            worker, 'config', return_value={'models': {'test-model': {'enabled': True}}}
        ):
            async with AsyncClient(transport=ASGITransport(app=worker.app), base_url='http://test') as client:
                async def launch(key, body=request):
                    return await client.post(route, json=body, headers={'idempotency-key': key})

                first = await launch('first')
                self.assertEqual(first.status_code, 200)
                self.assertEqual((await launch('second')).status_code, 200)
                conflict = await launch('first', {**request, 'runId': 'different'})
                self.assertEqual(conflict.status_code, 409)
                self.assertNotIn('error', conflict.json())
                busy = await launch('third')
                self.assertEqual(busy.status_code, 409)
                self.assertEqual(busy.json(), {'error': 'RUNTIME_INSTANCE_CAPACITY'})
                released = await client.delete(route + '/' + first.json()['instanceId'])
                self.assertTrue(released.is_success)
                self.assertEqual((await launch('third')).status_code, 200)

    async def test_empty_skill_baseline_has_no_instructions_or_hidden_assets(self):
        from integrations.openjiuwen.skill_set import hydrate_skill_set
        from integrations.openjiuwen.instance_manager import InstanceManager
        import hashlib
        request = {'skills': [], 'contentDigest': hashlib.sha256(b'').hexdigest()}
        hydrate_skill_set(request, InstanceManager())
        self.assertIsNone(request['skill'])
        self.assertEqual(request['variant']['mode'], 'without_target_skill')
        for extra in ({'assets': {'hidden.txt': 'eA=='}}, {'entryInstructionsFile': 'hidden.md'}, {'contentDigest': 'a'*64}):
            with self.assertRaises(ValueError):
                hydrate_skill_set({'skills': [], 'contentDigest': hashlib.sha256(b'').hexdigest(), **extra}, InstanceManager())

    async def test_worker_advertises_the_process_contract_emitted_by_sessions(self):
        from integrations.openjiuwen import worker
        with patch.object(worker, 'config', return_value={
            'models': {'test-model': {'upstreamModelId': 'test-model'}},
            'defaultModelId': 'test-model',
        }):
            capabilities = await worker.runtime_capabilities()
        self.assertTrue(capabilities['features']['processEvidence'])
        self.assertTrue(capabilities['features']['streaming'])

    async def test_parallel_same_name_calls_keep_their_own_values(self):
        process = EvaluationProcess()
        async def invoke(value):
            process.start('tool', 'lookup', {'id': value})
            await asyncio.sleep(0)
            process.end('tool', 'lookup', {'value': value})
        await asyncio.gather(invoke(1), invoke(2))
        result = process.finish()
        self.assertEqual(result['status'], 'COMPLETE')
        self.assertEqual([r['input']['id'] for r in result['records']], [r['output']['value'] for r in result['records']])

    async def test_redaction_limits_and_unfinished_calls(self):
        process = EvaluationProcess(lambda value: value.replace('credential-value', '[redacted]'))
        process.start('tool', 'lookup', {'apiKey': 'credential-value', 'query': 'credential-value'})
        process.end('tool', 'lookup', {'text': 'x' * 20000})
        process.start('tool', 'pending')
        result = process.finish()
        self.assertEqual(result['status'], 'PARTIAL')
        self.assertNotIn('credential-value', str(result))
        self.assertNotIn('output', result['records'][0])
        self.assertEqual(result['records'][1]['status'], 'incomplete')

if __name__ == '__main__':
    unittest.main()
