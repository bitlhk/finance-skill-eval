import unittest

from evaluation.orchestration import execute
from improvement.policy import comparable, select, review_input_gate, validate_review_references, holdout_goal
from evaluation.evidence import execute as answer_evidence
from evaluation.comparison import execute as comparison


class ReviewEvidenceGateTests(unittest.TestCase):
    def test_holdout_goal_uses_selected_target_and_requires_complete_cases(self):
        cases=[{'id':'one','passed':True},{'id':'two','passed':False}]
        self.assertTrue(holdout_goal(cases,0.5))
        self.assertFalse(holdout_goal(cases,0.75))
        self.assertFalse(holdout_goal([cases[0],{'id':'two','passed':None}],0.5))
        self.assertFalse(holdout_goal([cases[0],cases[0]],0.5))
        self.assertFalse(holdout_goal([],0))

    def test_requires_complete_unique_comparable_evidence(self):
        item = {'evidenceId': 'case-1', 'completed': True, 'comparable': True}
        self.assertIsNone(review_input_gate([item]))
        self.assertEqual(review_input_gate([])['status'], 'ABSTAINED')
        self.assertEqual(review_input_gate([{**item, 'comparable': False}])['status'], 'ABSTAINED')
        with self.assertRaisesRegex(ValueError, 'Duplicate review evidence'):
            review_input_gate([item, item])

    def test_review_cannot_cite_missing_or_duplicate_cases(self):
        evidence = [{'evidenceId': 'case-1', 'completed': True, 'comparable': True}]
        result = {'status': 'PRODUCED', 'review': {'evidenceIds': ['case-1']}}
        self.assertEqual(validate_review_references(evidence, result), result)
        for citations in (['unknown'], ['case-1', 'case-1']):
            with self.assertRaisesRegex(ValueError, 'unknown or duplicate'):
                validate_review_references(evidence, {'status': 'PRODUCED', 'review': {'evidenceIds': citations}})
def evaluation(identity, results):
    return {'id': identity, 'candidate': {'id': identity, 'digest': identity}, 'protocolDigest': 'p',
            'cases': [{'id': str(index), 'passed': passed} for index, passed in enumerate(results)]}


class EvaluationOrchestrationTest(unittest.TestCase):
    def test_requirement_coverage_keeps_missing_and_indeterminate_results_unverified(self):
        requirements = [{'id': 'passed'}, {'id': 'failed'}, {'id': 'unknown'}, {'id': 'missing'}]
        cases = [
            {'id': 'case-1', 'requirementResults': [
                {'id': 'passed', 'passed': True}, {'id': 'failed', 'passed': True},
                {'id': 'unknown', 'passed': None}]},
            {'id': 'case-2', 'requirementResults': [{'id': 'failed', 'passed': False}]},
            {'id': 'case-3'},
        ]
        self.assertEqual(execute({'action': 'requirement_coverage', 'requirements': requirements, 'cases': cases}), [
            {'id': 'passed', 'status': 'PASSED', 'caseIds': ['case-1']},
            {'id': 'failed', 'status': 'FAILED', 'caseIds': ['case-1', 'case-2']},
            {'id': 'unknown', 'status': 'UNVERIFIED', 'caseIds': ['case-1']},
            {'id': 'missing', 'status': 'UNVERIFIED', 'caseIds': []},
        ])

    def test_requirement_coverage_requires_all_linked_cases_to_be_assessed(self):
        requirements = [{'id': 'r1'}, {'id': 'r2'}, {'id': 'r3'}]
        planned = [{'id': 'ok', 'requirementIds': ['r1', 'r2']},
                   {'id': 'judge-timeout', 'requirementIds': ['r1', 'r2']},
                   {'id': 'not-executed', 'requirementIds': ['r1', 'r3']}]
        cases = [{'id': 'ok', 'requirementResults': [{'id': 'r1', 'passed': True}, {'id': 'r2', 'passed': False}]},
                 {'id': 'judge-timeout'}, {'id': 'unrelated', 'requirementResults': [{'id': 'r3', 'passed': True}]}]
        self.assertEqual(execute({'action': 'requirement_coverage', 'requirements': requirements,
                                  'plannedCases': planned, 'cases': cases}), [
            {'id': 'r1', 'status': 'UNVERIFIED', 'caseIds': ['ok'], 'plannedCaseIds': ['ok', 'judge-timeout', 'not-executed'], 'pendingCaseIds': ['judge-timeout', 'not-executed']},
            {'id': 'r2', 'status': 'FAILED', 'caseIds': ['ok'], 'plannedCaseIds': ['ok', 'judge-timeout'], 'pendingCaseIds': ['judge-timeout']},
            {'id': 'r3', 'status': 'UNVERIFIED', 'caseIds': [], 'plannedCaseIds': ['not-executed'], 'pendingCaseIds': ['not-executed']},
        ])

    def test_answer_projection_only_exposes_available_scalar_facts(self):
        resources = {'output': 'done', 'toolEvidence': [{'status': 'completed',
                     'result': '{"status":"booked","secret":"private"}'}]}
        plan = {'version': '1', 'answerEvidence': [{'id': 'status', 'reference': '/toolEvidence/0/result/status'}]}
        result = answer_evidence({'resources': resources, 'plan': plan})
        self.assertEqual(result['materials']['businessFacts'], {'status': 'booked'})
        self.assertNotIn('private', str(result))
        resources['toolEvidence'][0]['status'] = 'failed'
        self.assertIsNone(answer_evidence({'resources': resources, 'plan': plan})['materials']['businessFacts']['status'])

    def test_comparison_does_not_judge_failed_execution(self):
        case = {'caseId': 'one', 'name': 'one', 'prompt': 'x', 'evaluationGoal': 'y'}
        body = {'evalCase': case, 'left': {'status': 'failed'}, 'right': {'status': 'completed'},
                'independent': False, 'hasMethods': False, 'resources': {'left': {'output': ''}, 'right': {'output': '42'}}}
        progress = {'methodResults': {}, 'judgeDone': False, 'judge': None, 'judgeError': None}
        self.assertEqual(comparison({'action': 'next', 'body': body, 'progress': progress})['kind'], 'skipJudge')
        progress.update(judgeDone=True, judgeError='incomplete')
        report = comparison({'action': 'finish', 'body': body, 'progress': progress})
        self.assertIsNone(report['judge'])
        self.assertEqual(report['answerEvidence']['right']['materials']['output'], '42')

    def test_dependencies_and_verdicts(self):
        methods = [{'id': 'rule'}, {'id': 'judge', 'dependsOn': ['rule']}]
        self.assertIsNone(execute({'action': 'validate', 'methods': methods}))
        self.assertEqual(execute({'action': 'next', 'methods': methods, 'results': []})['kind'], 'RUN')
        self.assertEqual(execute({'action': 'next', 'methods': methods, 'results': [{'methodId': 'rule', 'status': 'FAIL'}]})['kind'], 'SKIP')
        self.assertEqual(execute({'action': 'complete', 'checks': [{'id': 'a', 'status': 'FAIL'}, {'id': 'b', 'status': 'PASS'}]})['status'], 'FAIL')
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            execute({'action': 'complete', 'checks': [{'id': 'a', 'status': 'PASS'}, {'id': 'a', 'status': 'PASS'}]})

    def test_ordinary_regression_needs_review_but_is_not_automatically_rejected(self):
        before, after = evaluation('before', [True, False, False]), evaluation('after', [False, True, True])
        review = {'status': 'PRODUCED', 'review': {'recommendation': 'KEEP_CANDIDATE', 'reason': 'Goal improved',
                  'evidenceIds': ['0', '1'], 'regressions': ['0'], 'tradeoff': 'Business priority'}}
        self.assertTrue(comparable(before, after))
        self.assertTrue(select(before, after, before, review)['selected'])
        self.assertFalse(select(before, after, before, review, ['0'])['selected'])
        duplicate = {**review, 'review': {**review['review'], 'evidenceIds': ['1', '1']}}
        self.assertFalse(select(before, after, before, duplicate)['selected'])


if __name__ == '__main__':
    unittest.main()
