import asyncio
from copy import deepcopy
import unittest
from unittest.mock import AsyncMock
from evaluation.case_state import with_case_state, ExecutionFailure
from tasks.values import fingerprint


class CaseStateTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.state, self.phases = {'bookings': 0}, []
        self.request = {'runId': 'run', 'side': 'right', 'evalCase': {'caseId': 'case', 'stateFixture': {
            'fixtureId': 'booking-test', 'version': '1', 'initialStateDigest': fingerprint(self.state)}}}

    async def port(self, request):
        self.phases.append(request['phase'])
        if request['phase'] != 'capture':
            self.state = {'bookings': 0}
        return {**request, 'status': 'SUCCEEDED', 'state': deepcopy(self.state), 'stateDigest': fingerprint(self.state)}

    async def book(self):
        self.state['bookings'] += 1
        return {'output': 'Booked', 'metadata': {}}

    async def test_repeated_attempts_capture_and_restore_actual_state(self):
        for _ in range(2):
            result = await with_case_state(self.request, self.port, self.book)
            self.assertEqual(result['metadata']['state'], {'bookings': 1})
            self.assertEqual(result['metadata']['caseState']['status'], 'COMPLETE')
            self.assertEqual(self.state, {'bookings': 0})
        self.assertEqual(self.phases, ['prepare', 'capture', 'restore'] * 2)

    async def test_failure_and_cancellation_restore_without_replaying_business(self):
        for cancelled in (False, True):
            saved = []
            async def interrupted():
                await self.book()
                if cancelled:
                    raise asyncio.CancelledError('business interrupted')
                raise RuntimeError('business interrupted')
            execute = AsyncMock(side_effect=interrupted)
            with self.assertRaises(asyncio.CancelledError if cancelled else ExecutionFailure):
                await with_case_state(self.request, self.port, execute, saved.append)
            self.assertEqual(execute.await_count, 1)
            self.assertEqual(self.state, {'bookings': 0})
            self.assertEqual(saved[0]['status'], 'COMPLETE')

    async def test_invalid_initial_state_never_executes_business(self):
        async def wrong(request):
            result = await self.port(request)
            if request['phase'] == 'prepare':
                result['stateDigest'] = 'a' * 64
            return result
        execute = AsyncMock()
        with self.assertRaisesRegex(ExecutionFailure, 'digest mismatch'):
            await with_case_state(self.request, wrong, execute)
        execute.assert_not_awaited()
        self.assertIn('restore', self.phases)

    async def test_failure_diagnostics_survive_state_capture_and_restore(self):
        async def crashed():
            raise ExecutionFailure('Runtime process exited', {
                'runtimeFailure': {'kind': 'PROCESS_EXIT', 'exitCode': 1}, 'caseState': {'status': 'STALE'}})
        with self.assertRaises(ExecutionFailure) as caught:
            await with_case_state(self.request, self.port, crashed)
        self.assertEqual(caught.exception.metadata['runtimeFailure']['exitCode'], 1)
        self.assertEqual(caught.exception.metadata['caseState']['status'], 'COMPLETE')
        self.assertEqual(self.phases, ['prepare', 'capture', 'restore'])

    async def test_failed_restore_keeps_output_and_reports_incomplete(self):
        async def offline(request):
            if request['phase'] == 'restore':
                raise RuntimeError('restore offline')
            return await self.port(request)
        result = await with_case_state(self.request, offline, self.book)
        self.assertEqual(result['output'], 'Booked')
        self.assertEqual(result['metadata']['caseState']['status'], 'INCOMPLETE')
        self.assertEqual(result['metadata']['caseState']['errors'][0]['phase'], 'restore')
