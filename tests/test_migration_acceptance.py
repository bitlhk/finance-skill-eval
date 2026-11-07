import asyncio
from copy import deepcopy
import unittest

from migration.acceptance import accept
from tasks.application_host import CapabilityError


class Fixture:
    def __init__(self, repetitions=1, case_ids=('one',)):
        self.context = {'candidate': {'id': 'candidate', 'digest': 'digest'},
            'configuration': {}, 'configurationDigest': 'configuration', 'suiteDigest': 'suite',
            'bundle': {'digest': 'digest'}, 'purpose': 'candidate', 'phase': 'development',
            'suite': {'executionRepetitions': repetitions}, 'judgeDigest': 'judge',
            'cases': [{'caseId': ident} for ident in case_ids],
            'authoredCases': [{'id': ident} for ident in case_ids], 'requirements': []}
        self.saved, self.closed, self.opened, self.executed = {}, 0, 0, []

    def save(self, value):
        self.saved[value['runId']] = deepcopy(value['run'])

    def open(self, _):
        self.opened += 1
        return {'environmentSnapshot': {'version': '1'}}

    def execute(self, value):
        self.executed.append(value['case']['caseId'])
        return {'status': 'completed', 'metadata': {}, 'output': 'ok'}

    def assess(self, _):
        return {'verdict': {'passed': True, 'reason': 'ok'}, 'valid': True, 'judgeFailed': False,
                'incomplete': False, 'executionChecks': [{'id': 'execution.completed', 'status': 'PASS'}],
                'methodResults': []}

    def close(self, _):
        self.closed += 1
        return {'receipt': {'status': 'RELEASED'}}

    def handlers(self):
        return {'describe': lambda _: self.context, 'register_run': self.save, 'save_run': self.save,
                'progress': lambda _: None, 'open_runtime': self.open, 'admit_runtime': lambda _: None,
                'execute_case': self.execute, 'assess_case': self.assess, 'judge_identity': lambda _: 'judge',
                'log_case': lambda _: None, 'close_runtime': self.close}


class MigrationAcceptanceTests(unittest.IsolatedAsyncioTestCase):
    async def test_repetitions_have_independent_runs_and_per_case_cleanup(self):
        fixture = Fixture(3, ('one', 'two'))
        await accept(fixture.handlers())
        self.assertEqual(len(fixture.saved), 3)
        self.assertEqual((fixture.opened, fixture.closed), (6, 6))
        runs = list(fixture.saved.values())
        self.assertEqual([run['repetition']['index'] for run in runs], [1, 2, 3])
        self.assertEqual(len({run['repetition']['groupId'] for run in runs}), 1)
        self.assertTrue(all(run['status'] == 'PASSED' and len(run['finalization']) == 2 for run in runs))

    async def test_unverified_requirement_does_not_erase_effect_score(self):
        fixture = Fixture()
        fixture.context['requirements'] = [{'id': 'required'}]
        await accept(fixture.handlers())
        run = next(iter(fixture.saved.values()))
        self.assertEqual((run['effectStatus'], run['status']), ('PASSED', 'INCOMPLETE'))
        self.assertEqual(run['requirementCoverage'][0]['status'], 'UNVERIFIED')

    async def test_failed_judge_stops_repetitions_without_replaying_business_effect(self):
        fixture = Fixture(3)
        handlers = fixture.handlers()
        handlers['assess_case'] = lambda _: {'error': {'message': 'Judge unavailable'}}
        await accept(handlers)
        self.assertEqual(fixture.executed, ['one'])
        run = next(iter(fixture.saved.values()))
        self.assertEqual((run['status'], run['cases'][0]['failureStage']), ('INCOMPLETE', 'JUDGE'))
        self.assertEqual(fixture.closed, 1)

    async def test_failed_restore_stops_following_cases(self):
        fixture = Fixture(3, ('one', 'two'))
        handlers = fixture.handlers()
        def execute(value):
            result = fixture.execute(value)
            result['metadata']['caseState'] = {'status': 'INCOMPLETE'}
            return result
        def assess(value):
            return {**fixture.assess(value), 'valid': False, 'incomplete': True,
                    'verdict': {'passed': False, 'unverified': True, 'reason': 'restore failed'}}
        handlers.update(execute_case=execute, assess_case=assess)
        await accept(handlers)
        self.assertEqual(fixture.executed, ['one'])
        self.assertEqual(len(fixture.saved), 1)

    async def test_cleanup_failure_saves_receipt_before_propagating(self):
        fixture = Fixture()
        handlers = fixture.handlers()
        handlers['close_runtime'] = lambda _: {'receipt': {'status': 'UNKNOWN'}, 'error': {'message': 'release unconfirmed'}}
        with self.assertRaisesRegex(CapabilityError, 'release unconfirmed'):
            await accept(handlers)
        self.assertEqual(next(iter(fixture.saved.values()))['finalization'], [{'status': 'UNKNOWN'}])

    async def test_cancellation_closes_runtime_and_preserves_case_evidence(self):
        fixture = Fixture(3)
        handlers, started = fixture.handlers(), asyncio.Event()
        async def execute(_):
            started.set()
            await asyncio.Event().wait()
        handlers['execute_case'] = execute
        task = asyncio.create_task(accept(handlers))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        run = next(iter(fixture.saved.values()))
        self.assertEqual(fixture.closed, 1)
        self.assertEqual(run['finalization'], [{'status': 'RELEASED'}])
        self.assertEqual(run['cases'][0]['failureStage'], 'RUNTIME')
        self.assertEqual(len(fixture.saved), 1)

    async def test_changed_environment_stops_before_second_business_call(self):
        fixture = Fixture(case_ids=('one', 'two'))
        handlers = fixture.handlers()
        def open(_):
            fixture.opened += 1
            return {'environmentSnapshot': {'version': str(fixture.opened)}}
        handlers['open_runtime'] = open
        await accept(handlers)
        self.assertEqual(fixture.executed, ['one'])
        self.assertEqual(fixture.closed, 2)
        run = next(iter(fixture.saved.values()))
        self.assertEqual(run['runtimeFailureSnapshot'], {'version': '2'})
        self.assertEqual(run['status'], 'INCOMPLETE')
