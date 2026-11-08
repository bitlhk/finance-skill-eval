import asyncio
from copy import deepcopy
import unittest
from evaluation.launcher_execution import execute_launchers


class LauncherExecutionTests(unittest.IsolatedAsyncioTestCase):
    async def test_capacity_one_releases_the_first_side_before_waiting_for_the_second(self):
        capacity = asyncio.Semaphore(1)
        events, calls = [], []
        class Owner:
            def __init__(self, options):
                self.side, self.held = options['side'], False
            async def prepare(self, _context):
                await capacity.acquire()
                self.held = True
                calls.append(('prepare', self.side))
            async def execute(self, _request, _emit):
                return {'status': 'completed', 'output': self.side}
            async def cleanup(self):
                if self.held:
                    calls.append(('cleanup', self.side))
                    self.held = False
                    capacity.release()
            def finalization_evidence(self):
                return {'status': 'RELEASED' if not self.held else 'UNKNOWN'}
        body = {'runId': 'run', 'launchers': {side: {'side': side} for side in ('left', 'right')},
                'pack': {'cases': [{'caseId': 'one'}], 'models': {'execution': {'left': {}, 'right': {}}},
                         'variants': {'left': {}, 'right': {}}}}
        async def emit(record):
            events.append(record)
        result = await asyncio.wait_for(execute_launchers(body, emit, Owner), 2)
        self.assertEqual(set(result['one']), {'left', 'right'})
        self.assertLess(calls.index(('cleanup', 'left')), calls.index(('prepare', 'right')))
        self.assertEqual(events[-1]['finalization']['errors'], [])

    async def exercise(self, fail_prepare=False, cancel=False, stateful=False):
        events, calls, owners = [], [], {}
        started = asyncio.Event()
        active = 0
        class Owner:
            def __init__(self, options):
                self.side = options['side']
                self.released = False
                self.state_supported = True
                owners[self.side] = self
            async def prepare(self, context):
                calls.append(('prepare', self.side))
                if fail_prepare and self.side == 'left':
                    raise RuntimeError('prepare failed')
            async def execute(self, request, on_event):
                nonlocal active
                self_test.assertNotIn('evaluationPlan', request['evalCase'])
                calls.append(('execute', self.side, request['evalCase']['caseId']))
                if stateful:
                    active += 1
                    self_test.assertEqual(active, 1, 'Mutable fixture reset/capture/restore must not overlap')
                    await asyncio.sleep(.01)
                    active -= 1
                if cancel:
                    started.set()
                    await asyncio.Future()
                return {'status': 'completed', 'output': self.side}
            async def cleanup(self):
                self.released = True
                calls.append(('cleanup', self.side))
            def finalization_evidence(self):
                return {'status': 'RELEASED' if self.released else 'UNKNOWN'}
        self_test = self
        async def emit(value):
            events.append(deepcopy(value))
        body = {'runId': 'run', 'launchers': {side: {'side': side} for side in ('left', 'right')}, 'pack': {
            'cases': [{'caseId': 'one', 'evaluationPlan': {'private': 'grading'}}, {'caseId': 'two'}],
                         'models': {'execution': {side: {'modelId': 'controlled'} for side in ('left', 'right')}}, 'variants': {'left': {}, 'right': {}}}}
        if stateful:
            body['pack']['cases'][0]['stateFixture'] = {'fixtureId': 'shared', 'version': '1', 'initialStateDigest': 'a' * 64}
        task = asyncio.create_task(execute_launchers(body, emit, Owner))
        if cancel:
            await started.wait()
            task.cancel()
        if fail_prepare:
            with self.assertRaisesRegex(RuntimeError, 'prepare failed'):
                await task
        elif cancel:
            with self.assertRaises(asyncio.CancelledError):
                await task
        else:
            result = await task
            self.assertEqual(set(result['one']), {'left', 'right'})
            self.assertEqual(set(result['two']), {'left', 'right'})
            self.assertTrue(all(value['status'] == 'completed' for sides in result.values() for value in sides.values()))
        self.assertTrue(all(owner.released for owner in owners.values()))
        self.assertEqual(len([call for call in calls if call[0] == 'cleanup']), 2)
        self.assertEqual(events[-1]['finalization']['resources']['left']['status'], 'RELEASED')
        self.assertIn('evaluationPlan', body['pack']['cases'][0])

    async def test_two_sides_and_frozen_grading_material(self):
        await self.exercise()

    async def test_stateful_sides_do_not_overlap_mutable_fixture_lifecycles(self):
        await self.exercise(stateful=True)

    async def test_prepare_failure_releases_both_owners(self):
        await self.exercise(fail_prepare=True)

    async def test_cancellation_releases_both_owners(self):
        await self.exercise(cancel=True)
