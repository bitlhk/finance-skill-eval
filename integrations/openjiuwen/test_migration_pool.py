import asyncio
import os
import unittest
from unittest.mock import patch
from uuid import uuid4

from integrations.openjiuwen.migration_pool import MigrationPool, _Factory


class MigrationPoolTest(unittest.IsolatedAsyncioTestCase):
    async def test_execution_configuration_reaches_instance_without_unrelated_secrets(self):
        values={'FINANCE_EVAL_PROJECT_EXECUTION_IMAGE':'approved:1','FINANCE_EVAL_DOCKER_WSL_DISTRIBUTION':'Ubuntu',
                'FINANCE_EVAL_DOCKER_WSL_USER':'root','UNRELATED_SECRET':'not-forwarded',
                'FINANCE_EVAL_JUDGE_MODEL': 'fixture-judge', 'FINANCE_EVAL_JUDGE_API_KEY': 'fixture-key',
                'FINANCE_EVAL_MODEL_MAX_RETRIES': '12', 'NODE_ENV': 'production', 'TMPDIR': '/shared/test-commands'}
        with patch.dict(os.environ,values,clear=True), \
             patch('integrations.openjiuwen.migration_pool.ProcessServiceHandler') as process, \
             patch('integrations.openjiuwen.migration_pool.ServiceHandler'), \
             patch('integrations.openjiuwen.migration_pool.WSServiceMessageChannel'):
            await _Factory().new_service(object())
        env=process.call_args.kwargs['env_vars']
        self.assertEqual(env['FINANCE_EVAL_PROJECT_EXECUTION_IMAGE'],'approved:1')
        self.assertEqual(env['FINANCE_EVAL_DOCKER_WSL_DISTRIBUTION'],'Ubuntu')
        self.assertEqual(env['FINANCE_EVAL_DOCKER_WSL_USER'],'root')
        self.assertNotIn('UNRELATED_SECRET',env)
        self.assertEqual(env['FINANCE_EVAL_JUDGE_MODEL'], 'fixture-judge')
        self.assertEqual(env['FINANCE_EVAL_JUDGE_API_KEY'], 'fixture-key')
        self.assertEqual(env['FINANCE_EVAL_MODEL_MAX_RETRIES'], '12')
        self.assertEqual(env['NODE_ENV'], 'production')
        self.assertEqual(env['TMPDIR'], '/shared/test-commands')

    async def test_real_runtime_starts_instances_and_routes_parallel_sessions(self):
        pool = MigrationPool(max_services=2, session_ttl=0, service_ttl=0)
        await pool.start()
        async def run(session):
            return [frame async for frame in pool.stream(session, uuid4().hex, {})]
        try:
            first, second = await asyncio.wait_for(asyncio.gather(run('task-a'), run('task-b')), 60)
            # Both invalid payloads reach separate deployed Agent services and
            # return an explicit failure, rather than being accepted silently.
            self.assertTrue(any(frame.get('error') for frame in first), first)
            self.assertTrue(any(frame.get('error') for frame in second), second)
            self.assertTrue(first[-1].get('completed'), first)
            self.assertTrue(second[-1].get('completed'), second)
        finally:
            await pool.stop()


if __name__ == '__main__':
    unittest.main()
