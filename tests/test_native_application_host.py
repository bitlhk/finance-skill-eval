import asyncio
import unittest

from tasks.application_host import CapabilityError, call, run_program
from evaluation.comparison import run as comparison


class NativeApplicationTests(unittest.IsolatedAsyncioTestCase):
    async def test_existing_comparison_program_uses_python_methods_and_judge(self):
        calls = []
        async def methods(value):
            calls.append(('methods', value['side']))
            return [{'methodId': 'rule', 'status': 'PASS'}]
        async def judge(value):
            calls.append(('judge', value))
            return {'winner': 'right'}
        evidence = {'status': 'completed'}
        body = {'evalCase': {'caseId': 'one', 'name': 'one', 'prompt': 'query', 'evaluationGoal': 'goal'},
                'left': evidence, 'right': evidence, 'hasMethods': True, 'independent': True,
                'resources': {'left': {'output': 'a'}, 'right': {'output': 'b'}}}
        result = await run_program(comparison(body), {'methods': methods, 'judge': judge})
        self.assertEqual(calls, [('methods', 'left'), ('methods', 'right'), ('judge', {})])
        self.assertEqual(result['judge']['winner'], 'right')
        self.assertEqual(result['methodResults']['left'][0]['status'], 'PASS')

    async def test_failure_is_returned_to_existing_application_error_policy(self):
        def workflow():
            try:
                yield call('execute')
            except CapabilityError as error:
                return error.detail
        def failed(_):
            raise ValueError('Runtime unavailable')
        result = await run_program(workflow(), {'execute': failed})
        self.assertEqual(result['message'], 'Runtime unavailable')

    async def test_cancellation_saves_receipt_but_never_runs_more_business_work(self):
        started, receipts = asyncio.Event(), []
        async def execute(_):
            started.set()
            await asyncio.Event().wait()
        async def save(value):
            await asyncio.sleep(0)
            receipts.append(value)
        def workflow():
            try:
                yield call('execute')
            except CapabilityError as error:
                yield call('save', {'cancelled': error.detail['aborted']}, cleanup=True)
                try:
                    yield call('forbidden')
                except CapabilityError:
                    pass
        task = asyncio.create_task(run_program(workflow(), {'execute': execute, 'save': save}))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(receipts, [{'cancelled': True}])

    async def test_shutdown_cancellation_is_distinct_from_a_user_cancel(self):
        started, receipts = asyncio.Event(), []
        closing = False
        async def execute(_):
            started.set()
            await asyncio.Event().wait()
        def workflow():
            try:
                yield call('execute')
            except CapabilityError as error:
                yield call('save', error.detail, cleanup=True)
        task = asyncio.create_task(run_program(workflow(), {'execute': execute, 'save': receipts.append},
                                               cancellation_context=lambda: {'closing': closing}))
        await started.wait()
        closing = True
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(receipts[0]['closing'])
        self.assertTrue(receipts[0]['aborted'])
