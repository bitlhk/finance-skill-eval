import hashlib
import unittest

from evaluation.checks import evaluate_check, evaluate_rule, read_pointer, validate_artifacts, validate_citations


class EvaluationRuleTests(unittest.TestCase):
    def test_equality_distinguishes_booleans_from_numbers(self):
        rule = {'operation': 'equals', 'expected': {'value': 1}}
        self.assertTrue(evaluate_rule(rule, {'value': 1.0}))
        self.assertFalse(evaluate_rule(rule, {'value': True}))

    def test_sets_ignore_duplicates_without_coercing_types(self):
        rule = {'operation': 'set_equals', 'expected': [1, True, '1']}
        self.assertTrue(evaluate_rule(rule, [True, '1', 1, 1]))
        self.assertFalse(evaluate_rule(rule, [1, '1']))
        self.assertFalse(evaluate_rule(rule, [1, True, '1', None]))

    def test_numeric_tolerance_rejects_boolean(self):
        rule = {'operation': 'numeric_tolerance', 'expected': 1, 'absoluteTolerance': 0.1, 'relativeTolerance': 0}
        self.assertTrue(evaluate_rule(rule, 1.05))
        self.assertFalse(evaluate_rule(rule, True))

    def test_evidence_pointers_keep_prior_array_and_escaping_behavior(self):
        evidence = {'items': [{'a/b': 3}]}
        self.assertEqual(read_pointer(evidence, '/items/0/a~1b'), 3)
        self.assertEqual(read_pointer(evidence, '/items/length'), 1)
        self.assertIsNone(read_pointer(evidence, '/items/00'))
        self.assertIsNone(read_pointer(evidence, '/items/__proto__'))
        check = {'id': 'rule', 'evidenceRefs': ['/missing'],
                 'rule': {'operation': 'exists', 'reference': '/items/0'}}
        self.assertEqual(evaluate_check(check, evidence)['status'], 'UNVERIFIED')

    def test_script_verdict_requires_real_citations(self):
        evidence = {'output': '42'}
        check = {'id': 'result', 'status': 'PASS', 'reason': 'correct'}
        self.assertEqual(validate_citations({'checks': [check]}, evidence)['checks'][0]['status'], 'UNVERIFIED')
        check['evidenceRefs'] = ['/output']
        self.assertEqual(validate_citations({'checks': [check]}, evidence)['checks'][0]['status'], 'PASS')
        check['evidenceRefs'] = ['/invented']
        with self.assertRaises(ValueError):
            validate_citations({'checks': [check]}, evidence)

    def test_artifacts_verify_contents_and_reject_duplicates(self):
        content = '报告 🚀'
        artifact = {'path': 'report.txt', 'content': content, 'source': 'runtime',
                    'sha256': hashlib.sha256(content.encode('utf-8')).hexdigest()}
        self.assertEqual(validate_artifacts([artifact])['artifacts'], [artifact])
        self.assertIsNone(validate_artifacts([artifact, artifact])['artifacts'])
        self.assertIsNone(validate_artifacts([{**artifact, 'content': 'tampered'}])['artifacts'])
        self.assertIsNone(validate_artifacts([{**artifact, 'unknown': True}])['artifacts'])


if __name__ == '__main__':
    unittest.main()
