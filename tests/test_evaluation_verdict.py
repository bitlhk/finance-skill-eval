import json
import unittest

from evaluation.verdict import task_verdict
from improvement.policy import review_input, comparison_evaluation
from evaluation.checks import execution_checks, comparison_incomplete
from copy import deepcopy


class ComparisonEvidenceTests(unittest.TestCase):
    def evidence(self):
        return {'status': 'completed', 'runtimeIdentityVerified': True, 'streamCompleted': True,
                'metadata': {'contentDigest': 'digest', 'projectExecution': True}, 'loadedSkills': []}

    def job(self):
        return {'jobId': 'job', 'configuration': {'executionRepetitions': 1}, 'report': {
            'variants': {'right': {'mode': 'skill_version', 'artifactSha256': 'digest'}},
            'cases': [{'caseId': 'one', 'left': self.evidence(), 'right': self.evidence(),
                       'judge': {'goalAssessment': {'verdict': 'PASS'}}}]}}

    def evaluate(self, job):
        return comparison_evaluation(job, {'id': 'candidate', 'digest': 'digest'}, ['one'], 'protocol')['cases'][0]['passed']

    def test_project_does_not_require_every_internal_skill_to_be_injected(self):
        expected = {'contentDigest': 'digest', 'executionMode': 'agent_project', 'members': [{'skillId': 'internal', 'version': '1'}]}
        checks = execution_checks(self.evidence(), expected)
        self.assertTrue(all(item['status'] == 'PASS' for item in checks))
        expected.pop('executionMode')
        self.assertEqual(execution_checks(self.evidence(), expected)[-1]['status'], 'UNVERIFIED')

    def test_business_failure_is_repeatable_but_missing_evidence_is_not(self):
        report = self.job()['report']
        report['cases'][0]['judge']['goalAssessment']['verdict'] = 'FAIL'
        self.assertFalse(comparison_incomplete(report))
        report['cases'][0]['right']['metadata']['caseState'] = {'status': 'UNAVAILABLE'}
        self.assertTrue(comparison_incomplete(report))

    def test_successful_last_repetition_cannot_hide_failure_or_missing_attempt(self):
        job = self.job()
        failed = deepcopy(job['report'])
        failed['cases'][0]['judge']['goalAssessment']['verdict'] = 'FAIL'
        job['configuration']['executionRepetitions'] = 2
        job['executionAttempts'] = [{'index': 0, 'status': 'COMPLETED', 'report': failed},
                                   {'index': 1, 'status': 'COMPLETED', 'report': job['report']}]
        self.assertFalse(self.evaluate(job))
        job['executionAttempts'].pop(0)
        self.assertIsNone(self.evaluate(job))

    def test_wrong_candidate_or_duplicate_case_cannot_get_passing_score(self):
        job = self.job()
        self.assertTrue(self.evaluate(job))
        job['report']['variants']['right']['artifactSha256'] = 'different'
        self.assertIsNone(self.evaluate(job))
        job = self.job()
        job['report']['cases'].append(deepcopy(job['report']['cases'][0]))
        self.assertIsNone(self.evaluate(job))

    def test_required_method_failure_overrides_model_success_and_unknown_stays_unknown(self):
        job = self.job()
        job['evaluationSpec'] = {'cases': [{'caseId': 'one', 'evaluationPlan': {'checks': [{'id': 'state', 'required': True}]}}]}
        method = {'methodId': 'plan:state', 'status': 'FAIL', 'checks': []}
        job['report']['cases'][0]['methodResults'] = {'right': [method]}
        self.assertFalse(self.evaluate(job))
        method['status'] = 'UNVERIFIED'
        self.assertIsNone(self.evaluate(job))

    def test_process_failure_cannot_be_hidden_by_a_high_answer_quality_score(self):
        job = self.job()
        case = job['report']['cases'][0]
        case['judge'] = {'dimensions': [{'rightScore': 4}]}
        method = {'methodId': 'execution-criteria', 'status': 'FAIL', 'checks': []}
        case['methodResults'] = {'right': [method]}
        self.assertFalse(self.evaluate(job))
        method['status'] = 'ERROR'
        self.assertIsNone(self.evaluate(job))
        method['status'] = 'PASS'
        self.assertTrue(self.evaluate(job))


class TaskVerdictTests(unittest.TestCase):
    def methods(self, status='PASS'):
        return [{'methodId': 'bundle-execution', 'status': 'PASS', 'checks': []},
                {'methodId': 'business-judge', 'status': status, 'checks': []}]

    def test_required_script_failure_overrides_passing_model_without_hiding_it(self):
        methods = self.methods() + [{'methodId': 'plan:state', 'status': 'FAIL',
            'checks': [{'status': 'FAIL', 'reason': 'state unchanged'}]}]
        verdict = {'passed': True, 'reason': 'model passed'}
        result = task_verdict(methods, verdict, {'checks': [{'id': 'state', 'required': True}]})
        self.assertFalse(result['verdict']['passed'])
        self.assertFalse(result['incomplete'])
        self.assertTrue(verdict['passed'])
        self.assertEqual(result['methodResults'][1]['status'], 'PASS')

    def test_error_is_incomplete_not_a_failed_quality_score(self):
        result = task_verdict(self.methods('ERROR'), {'passed': True, 'reason': 'old'})
        self.assertTrue(result['incomplete'])
        self.assertTrue(result['judgeFailed'])
        self.assertEqual(result['verdict'], {'passed': False, 'unverified': True, 'reason': '评判失败'})

    def test_missing_required_evidence_is_distinguished_from_failure(self):
        methods = self.methods() + [{'methodId': 'plan:state', 'status': 'UNVERIFIED',
            'checks': [{'status': 'UNVERIFIED', 'reason': 'no state receipt'}]}]
        result = task_verdict(methods, {'passed': True, 'reason': 'answer ok'}, {'checks': [{'id': 'state', 'required': True}]})
        self.assertTrue(result['incomplete'])
        self.assertFalse(result['verdict']['passed'])


class ReviewMaterialTests(unittest.TestCase):
    def evaluation(self, name, passed):
        return {'candidate': {'digest': name}, 'protocolDigest': 'protocol',
                'cases': [{'id': 'one', 'passed': passed, 'observation': {'output': name}}]}

    def test_current_candidate_baseline_and_incumbent_stay_separate(self):
        before, after, incumbent = (self.evaluation('baseline', True), self.evaluation('candidate', False), self.evaluation('working', True))
        result = review_input('target', before, after, [], {'incumbent': incumbent, 'remainingRounds': 2, 'targetPassRate': 0.8})
        item = result['evidence'][0]
        self.assertEqual(json.loads(item['summary']), {'before': True, 'after': False, 'incumbent': True})
        self.assertTrue(item['comparable'])
        self.assertEqual(item['candidate'], {'output': 'candidate'})
        self.assertEqual(result['remainingRounds'], 2)
        item['candidate']['output'] = 'changed by consumer'
        self.assertEqual(after['cases'][0]['observation']['output'], 'candidate')

    def test_incomplete_scores_do_not_become_zero_accuracy_or_comparable(self):
        result = review_input('target', self.evaluation('baseline', True), self.evaluation('candidate', None), [])
        self.assertIsNone(result['evaluationSummary']['candidate']['passRate'])
        self.assertFalse(result['evidence'][0]['completed'])
        self.assertFalse(result['evidence'][0]['comparable'])
