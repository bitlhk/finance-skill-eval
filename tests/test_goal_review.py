from copy import deepcopy
import unittest

from agents.effect_review import assess, gate
from improvement.policy import review_input, select_goal
from migration.evaluation_view import optimization_evaluation
from migration.facts import scope_digest
from migration.integrity import effect_report, verify_delivery
from migration.optimization import _review_requested, _review_completed
from tasks.values import fingerprint


class GoalReviewTests(unittest.TestCase):
    def fixture(self):
        suite = {'name': 'selected scope', 'cases': [{'id': 'one', 'input': 'Task', 'criteria': ['correct']}], 'holdoutCases': []}
        candidate = {'id': 'candidate-current', 'digest': 'a' * 64}
        run = {'id': 'run-current', 'candidateId': candidate['id'], 'candidateDigest': candidate['digest'],
            'phase': 'development', 'purpose': 'candidate', 'status': 'PASSED', 'cases': [{'id': 'one', 'passed': True}],
            'suite': suite, 'suiteDigest': fingerprint(suite), 'judgeDigest': 'judge', 'runtimeSnapshot': {'version': '1'},
            'configurationDigest': fingerprint({'modelId': 'model'})}
        current = {'id': 'attempt-current', 'kind': 'CHAT', 'status': 'RUNNING'}
        task = {'goal': 'Meet selected task', 'currentCandidateId': candidate['id'], 'candidates': [candidate],
            'configuration': {'modelId': 'model'}, 'suite': suite, 'runs': [run], 'attempts': [current]}
        review = {'status': 'PRODUCED', 'review': {'recommendation': 'KEEP_CANDIDATE', 'reason': 'Selected goal met',
            'improvements': [], 'regressions': [], 'evidenceIds': ['one']}}
        return task, current, run, review

    def test_single_result_review_reaches_delivery_without_fabricating_a_baseline(self):
        task, current, run, result = self.fixture()
        instruction = _review_requested(task, current, {'request': {'candidateRunId': run['id']}})
        self.assertEqual(instruction['assessmentMode'], 'GOAL')
        self.assertNotIn('baselineRunId', instruction)
        evaluated = optimization_evaluation(task, run)
        material = review_input(task['goal'], None, evaluated, [])
        self.assertIsNone(gate(material))
        self.assertNotIn('baselineDigest', material)
        self.assertNotIn('baseline', material['evaluationSummary'])
        self.assertNotIn('baseline', material['evidence'][0])
        reviewed = assess(material, result)
        self.assertTrue(select_goal(evaluated, reviewed)['selected'])
        _review_completed(task, current, {'baseline': None, 'evaluated': evaluated, 'incumbent': None,
            'review': reviewed, 'evidence': material['evidence'], 'scopeDigest': scope_digest(task)})
        saved = task['effectReviews'][-1]
        self.assertIn('基础验证',task['attempts'][-1]['clarification'])
        self.assertTrue(task['attempts'][-1]['agentCanReview'])
        self.assertNotIn('baselineRunId', saved)
        self.assertEqual(effect_report(task, saved, 'judge')['evidenceStatus'], 'CHECKED')
        for attempt in task['attempts']:
            attempt['status'] = 'COMPLETED'
        basic = {'approved': True, 'report': {'coversTaskScope': True}}
        self.assertIsNotNone(verify_delivery(task, {'digest': 'a' * 64}, 'judge', basic))
        task['configuration']['modelId'] = 'changed'
        self.assertEqual(effect_report(task, saved, 'judge')['evidenceStatus'], 'STALE')
        self.assertIsNone(verify_delivery(task, {'digest': 'a' * 64}, 'judge', basic))

    def test_incomplete_or_comparative_claims_cannot_be_accepted_as_goal_review(self):
        task, _, run, result = self.fixture()
        evaluated = optimization_evaluation(task, run)
        material = review_input(task['goal'], None, evaluated, [])
        for field in ('improvements', 'regressions'):
            invalid = deepcopy(result)
            invalid['review'][field] = ['unsupported comparison']
            with self.assertRaises(ValueError):
                assess(material, invalid)
            self.assertFalse(select_goal(evaluated, invalid)['selected'])
        incomplete = deepcopy(material)
        incomplete['evidence'][0]['completed'] = False
        self.assertEqual(gate(incomplete)['status'], 'ABSTAINED')
        incomplete = deepcopy(evaluated)
        incomplete['cases'][0]['passed'] = None
        self.assertFalse(select_goal(incomplete, result)['selected'])
