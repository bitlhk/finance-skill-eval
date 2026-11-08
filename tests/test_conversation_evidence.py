import unittest

from evaluation.checks import evaluate_check
from evaluation.evidence import resources, execute


class ConversationEvidenceTests(unittest.TestCase):
    def test_tool_name_in_answer_cannot_replace_an_actual_first_turn_card_call(self):
        evidence = {'status': 'completed', 'output': '<tool_call>format_meetingroom_card</tool_call>', 'toolCalls': [],
                    'metadata': {'conversation': {'sessionId': 'actual', 'turns': [{'index': 0, 'toolNames': []}]}}}
        material = resources(evidence)
        check = {'id': 'first-turn-real-card', 'rule': {'operation': 'contains',
            'reference': '/execution/conversation/turns/0/toolNames', 'expected': 'format_meetingroom_card'}}
        self.assertEqual(evaluate_check(check, material)['status'], 'FAIL')
        evidence['metadata']['conversation']['turns'][0]['toolNames'] = ['skill_tool', 'format_meetingroom_card']
        self.assertEqual(evaluate_check(check, resources(evidence))['status'], 'PASS')
        answer = execute({'resources': resources(evidence)})
        self.assertNotIn('conversation', str(answer))
