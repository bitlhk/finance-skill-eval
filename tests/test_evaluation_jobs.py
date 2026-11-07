from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from evaluation.job_control import execute, freeze, EvaluationJobError
from evaluation.job_execution import run
from evaluation.rescoring import run as rescore, rescore_single
import asyncio
from storage.jobs import execute as store
from tasks.application_host import ExecutionHost, CapabilityError
from tasks.values import fingerprint


class SingleRescoringTests(unittest.IsolatedAsyncioTestCase):
    def source(self):
        return {'id': 'original', 'status': 'PASSED', 'cases': [{'id': 'one', 'evidence': {'output': 'frozen'}}]}

    async def test_repetitions_grade_frozen_evidence_and_do_not_mutate_source(self):
        source, seen = self.source(), []
        before = deepcopy(source)
        async def assess(inputs):
            seen.append(deepcopy(inputs))
            inputs['evidence']['output'] = 'modified by judge'
            return {'incomplete': False, 'verdict': {'passed': len(seen) == 1, 'reason': 'reason'}, 'methodResults': []}
        result = await rescore_single(source, {'repetitions': 2}, [{'caseId': 'one'}],
                                     {'judge_info': lambda _: 'judge-v1', 'assess_case': assess})
        self.assertEqual([item['evidence']['output'] for item in seen], ['frozen', 'frozen'])
        self.assertEqual(source, before)
        self.assertEqual(result['sourceDigest'], fingerprint(before))
        self.assertEqual(result['stability'][0]['agreement'], 0.5)
        self.assertEqual(result['repetitions'], 2)

    async def test_unavailable_evidence_and_unfrozen_requirements_do_not_call_judge(self):
        source = self.source()
        source['cases'].append({'id': 'missing'})
        result = await rescore_single(source, {}, [{'caseId': 'one'}], {'judge_info': lambda _: None},
                                     requirement_ids={'one': ['required']})
        self.assertEqual([item['status'] for item in result['cases']], ['UNVERIFIED', 'UNVERIFIED'])

    async def test_judge_configuration_change_discards_result(self):
        identities = iter(['original', 'changed'])
        async def assess(_):
            return {'incomplete': False, 'verdict': {'passed': True, 'reason': 'ok'}, 'methodResults': []}
        with self.assertRaisesRegex(ValueError, 'configuration changed'):
            await rescore_single(self.source(), {'repetitions': 2}, [{'caseId': 'one'}],
                                 {'judge_info': lambda _: next(identities), 'assess_case': assess})

    async def test_invalid_repeat_count_rejected_before_any_judge(self):
        for count in (0, 6, True, 1.5):
            with self.subTest(count=count), self.assertRaisesRegex(ValueError, 'repetitions'):
                await rescore_single(self.source(), {'repetitions': count}, [{'caseId': 'one'}], {})

    async def test_cancellation_stops_subsequent_judgement(self):
        started, calls = asyncio.Event(), []
        async def assess(_):
            calls.append('judge')
            started.set()
            await asyncio.Event().wait()
        task = asyncio.create_task(rescore_single(self.source(), {'repetitions': 3}, [{'caseId': 'one'}],
                                                 {'judge_info': lambda _: None, 'assess_case': assess}))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(calls, ['judge'])


def configuration(**changes):
    return {'runtime': {'type': 'replay'}, 'executionRepetitions': 3, 'repeatSafety': 'read_only', **changes}


def pack():
    return {'packId': 'suite', 'version': '1', 'targetSkillId': 'skill', 'targetSkillVersion': '1', 'packFingerprint': 'original',
        'models': {'execution': {'left': {}, 'right': {}}}, 'variants': {'left': {}, 'right': {}},
        'cases': [{'caseId': 'one', 'name': 'one', 'prompt': 'calculate'}]}


class JobHarness:
    def __init__(self, results, **changes):
        self.job = execute({'action': 'create', 'inputs': {'configuration': configuration(**changes)}})['job']
        self.results, self.calls = list(results), []
        self.host = ExecutionHost()

    def invoke(self, effect):
        p, name = effect['inputs'], effect['capability']
        self.calls.append(name)
        if name == 'save_job':
            self.job = deepcopy(p['job'])
            return deepcopy(self.job)
        if name == 'load_job':
            return deepcopy(self.job)
        if name == 'resolve_pack':
            return pack()
        if name == 'generate_questions':
            raise ValueError('private generation failure')
        if name == 'execute_once':
            self.job = deepcopy(p['job'])
            value = self.results.pop(0)
            if isinstance(value, Exception):
                raise value
            return {'job': self.job, 'report': {'reportFingerprint': 'old', 'cases': [{'caseId': 'one'}]}, 'incomplete': value}
        raise AssertionError(name)

    def run(self):
        effect = self.host.start(run({'job': self.job}))
        while effect['status'] == 'call':
            try:
                value, error = self.invoke(effect), None
            except Exception as failure:
                value = None
                error = getattr(failure, 'detail', {'name': type(failure).__name__, 'message': str(failure)})
            effect = self.host.advance(effect['executionId'], effect['token'], value, error)
        return self.job


class EvaluationJobTests(unittest.TestCase):
    def test_repeats_share_frozen_inputs_and_keep_all_reports(self):
        harness = JobHarness([False, False, False])
        job = harness.run()
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(harness.calls.count('execute_once'), 3)
        self.assertEqual([item['status'] for item in job['executionAttempts']], ['COMPLETED'] * 3)
        self.assertEqual(job['progress']['totalRuns'], 6)
        self.assertNotEqual(job['report']['reportFingerprint'], 'old')

    def test_uncertain_execution_stops_repeats_without_discarding_completed_reports(self):
        harness = JobHarness([False, True, False])
        job = harness.run()
        self.assertEqual(harness.calls.count('execute_once'), 2)
        self.assertTrue(job['assessmentIncomplete'])
        self.assertIn('后续业务运行未执行', job['executionRepetitionsStopped'])
        self.assertEqual(len(job['executionAttempts']), 2)

    def test_unsafe_repeats_are_rejected_before_runtime_acquisition(self):
        harness = JobHarness([], repeatSafety=None)
        job = harness.run()
        self.assertEqual(job['status'], 'failed')
        self.assertNotIn('execute_once', harness.calls)

    def test_ai_failure_does_not_silently_fall_back_to_another_suite(self):
        harness = JobHarness([], caseSource='ai_generated')
        job = harness.run()
        self.assertEqual(job['error']['code'], 'QUESTION_GENERATION_FAILED')
        self.assertNotIn('execute_once', harness.calls)

    def test_cancel_retains_a_failed_attempt_and_never_starts_another_repetition(self):
        harness = JobHarness([CapabilityError({'message': 'cancelled', 'aborted': True})])
        job = harness.run()
        self.assertEqual(job['status'], 'cancelled')
        self.assertEqual(len(job['executionAttempts']), 1)
        self.assertEqual(job['cancellation']['scope'], 'EVAL_WORKER_NOT_REMOTE_PROCESS_PROOF')

    def test_generated_and_holdout_case_ids_cannot_overlap(self):
        value = JobHarness([]).job
        value['configuration']['includeHoldout'] = True
        value['questionSet'] = {'cases': pack()['cases'], 'model': {}}
        suite = pack();suite['holdoutCases'] = suite['cases']
        with self.assertRaisesRegex(EvaluationJobError, 'caseId 冲突'):
            freeze(value, suite)

    def test_progress_preserves_live_text_tool_status_and_repeat_offset(self):
        value = JobHarness([]).job
        freeze(value, pack())
        events = [{'stage': 'executing', 'event': {'type': 'text_delta', 'caseId': 'one', 'side': 'right', 'text': 'answer'}},
            {'stage': 'executing', 'event': {'type': 'tool_start', 'caseId': 'one', 'side': 'right', 'toolName': 'query'}},
            {'stage': 'executing', 'event': {'type': 'tool_end', 'caseId': 'one', 'side': 'right', 'toolName': 'query'}},
            {'stage': 'judging', 'completedRuns': 2}]
        result = execute({'action': 'progress', 'job': value, 'inputs': {'events': events, 'iteration': 1}})['job']
        self.assertEqual(result['live']['one:right']['output'], 'answer')
        self.assertEqual(result['live']['one:right']['toolCalls'][0]['status'], 'completed')
        self.assertEqual(result['progress']['completedRuns'], 4)
        self.assertNotIn('live', value)

    def test_late_progress_cannot_undo_a_persisted_cancellation(self):
        with tempfile.TemporaryDirectory() as directory:
            value = JobHarness([]).job
            stale = deepcopy(value)
            cancelled = execute({'action': 'cancel', 'job': value})['job']
            store({'action': 'save', 'path': directory, 'job': cancelled})
            stale.update(status='completed', finalization={'runId': 'actual', 'resources': {'status': 'RELEASED'}})
            saved = store({'action': 'save', 'path': directory, 'job': stale})
            self.assertEqual(saved['status'], 'cancelled')
            self.assertEqual(saved['finalization']['runId'], 'actual')
            self.assertIn('workerSettledAt', saved['cancellation'])
            self.assertEqual(len(list(Path(directory).glob('*.json'))), 1)

    def test_rescore_commit_checks_original_report_and_keeps_business_evidence(self):
        value = JobHarness([]).job
        value.update(status='completed', report={'reportFingerprint': 'original', 'cases': [{'caseId': 'one'}]})
        record = {'id': 'rescore-one', 'sourceReportFingerprint': 'original'}
        saved = execute({'action': 'rescore_commit', 'job': value, 'inputs': {'record': record}})['job']
        self.assertEqual(saved['report'], value['report'])
        self.assertEqual(saved['rescorings'], [record])
        record['sourceReportFingerprint'] = 'other'
        with self.assertRaisesRegex(EvaluationJobError, '原报告已变化'):
            execute({'action': 'rescore_commit', 'job': value, 'inputs': {'record': record}})

    def test_finalization_saved_before_the_cancel_snapshot_is_not_erased(self):
        with tempfile.TemporaryDirectory() as directory:
            value = JobHarness([]).job
            cancelled = execute({'action': 'cancel', 'job': value})['job']
            value.update(status='running', finalization={'runId': 'finished-worker'})
            store({'action': 'save', 'path': directory, 'job': value})
            saved = store({'action': 'save', 'path': directory, 'job': cancelled})
            self.assertEqual(saved['status'], 'cancelled')
            self.assertEqual(saved['finalization']['runId'], 'finished-worker')

    def test_rescore_repeats_judgement_only_and_alternates_presentation(self):
        source = {'evaluationSpec': {'cases': pack()['cases']},
            'report': {'reportFingerprint': 'original', 'cases': [{'caseId': 'one', 'left': {'output': 'left'}, 'right': {'output': 'right'}}]}}
        host = ExecutionHost();orders = [];saved = []
        effect = host.start(rescore({'source': source, 'request': {'repetitions': 3, 'alternateOrder': True}}))
        while effect['status'] == 'call':
            name, p = effect['capability'], effect['inputs']
            if name == 'judge_info':
                value = {'judgeId': 'judge', 'supportsPresentationOrder': True, 'configurationDigest': 'configuration'}
            elif name == 'judge_case':
                orders.append(p['order']);self.assertEqual(p['original']['right']['output'], 'right')
                value = {'caseId': 'one', 'judge': {'winner': 'right'}}
            elif name == 'commit_rescore':
                saved.append(p['record']);value = None
            else:
                self.fail('Rescoring requested a business capability: ' + name)
            effect = host.advance(effect['executionId'], effect['token'], value)
        self.assertEqual(orders, ['normal', 'swapped', 'normal'])
        self.assertEqual(saved[0]['stability'][0]['agreement'], 1)

    def test_fingerprints_match_existing_sorted_json_records(self):
        self.assertEqual(fingerprint({'b': 2, 'a': 1.0}), fingerprint({'a': 1, 'b': 2}))

    def test_selected_suite_pins_matching_asset_and_models_without_mutating_catalog(self):
        suite = pack();suite['models']['judge'] = {'modelId': 'original-judge'}
        suite['variants'] = {'left': {'mode': 'no_skill'}, 'right': {'mode': 'skill_version', 'skillId': 'skill', 'version': '1'}}
        original = deepcopy(suite)
        config = configuration(runtime={'type': 'direct_model'}, selectedCaseIds=['one'], judgeMode='model', skillAssetId='asset')
        inputs = {'configuration': config, 'pack': suite, 'assets': {'right': {'skillId': 'skill', 'version': '1', 'artifactSha256': 'pinned'}},
            'defaults': {'execution': {'modelId': 'execution'}, 'judge': {'modelId': 'judge'}}}
        selected = execute({'action': 'resolve_pack', 'inputs': inputs})
        self.assertEqual(selected['variants']['right']['artifactSha256'], 'pinned')
        self.assertEqual(selected['models']['execution']['left']['modelId'], 'execution')
        self.assertEqual(selected['models']['judge']['modelId'], 'judge')
        self.assertEqual(suite, original)
        config['selectedCaseIds'] = ['missing']
        with self.assertRaisesRegex(EvaluationJobError, '所选评测案例不存在'):
            execute({'action': 'resolve_pack', 'inputs': inputs})
