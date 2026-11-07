import json
from copy import deepcopy
import unittest

from agents.criterion import judge_criteria
from evaluation.judges import ModelJudge, recover_quote


class NativeJudgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_frozen_user_confirmation_is_available_without_model_prompt_capture(self):
        from tasks.values import fingerprint
        seen = []
        async def invoke(body, _output):
            seen.append(deepcopy(body))
            return {'content': json.dumps({'criteria': [{'id': 'confirmation', 'passed': True,
                'reason': 'Frozen confirmation matches the runtime receipt',
                'evidenceRefs': ['/taskInput/turns/1/query']}]}), 'investigation': []}
        turns = [{'query': 'Show options first'}, {'query': 'Confirm the chosen booking'}]
        receipts = [{'index': i, 'queryDigest': fingerprint(t['query'])} for i, t in enumerate(turns)]
        inputs = {'evalCase': {'prompt': 'Book after confirmation', 'turns': turns,
            'rubric': [{'criterionId': 'confirmation', 'scope': 'execution'}]},
            'evidence': {'status': 'completed', 'output': 'booked', 'metadata': {
                'conversation': {'turns': receipts}, 'process': {'status': 'PARTIAL', 'reason': 'MODEL_INPUT_NOT_CAPTURED', 'records': []}}}}
        result = await judge_criteria(inputs, model={'modelId': 'controlled'}, invoke=invoke)
        self.assertTrue(result['passed'])
        self.assertTrue(seen[-1]['resources']['taskInput']['turns'][1]['runtimeQueryDigestMatches'])
        self.assertNotIn('taskInput', inputs['evidence']['metadata'])
        inputs['evidence']['metadata']['conversation']['turns'][1]['queryDigest'] = 'different'
        await judge_criteria(inputs, model={'modelId': 'controlled'}, invoke=invoke)
        self.assertFalse(seen[-1]['resources']['taskInput']['turns'][1]['runtimeQueryDigestMatches'])

    async def test_pairwise_uses_the_same_absolute_scale_as_candidate_assessment(self):
        ids = ['professional_fit', 'business_completeness', 'clarity', 'actionability']
        observed = []
        class Model:
            adapter_id = 'controlled'
            async def complete(self, request):
                observed.append(request)
                return {'content': json.dumps({'confidence': 'high', 'summary': 'both meet requirements', 'winner': 'TIE',
                    'dimensions': [{'id': key, 'aScore': 4, 'bScore': 4, 'reason': 'complete'} for key in ids]})}
        judge = ModelJudge('pairwise', {'providerId': 'controlled', 'modelId': 'controlled'}, adapter=Model())
        evidence = {'status': 'completed', 'output': 'actual answer', 'toolCalls': [], 'metadata': {}}
        result = await judge.quality({'caseId': 'one', 'prompt': 'task', 'evaluationGoal': 'correct answer\nPRIVATE_PROCESS_REQUIREMENT',
            'rubric': [{'description': 'correct answer', 'scope': 'answer'}, {'description': 'PRIVATE_PROCESS_REQUIREMENT', 'scope': 'execution'}]}, evidence, evidence,
            {'domainInstructions': 'Assess the task', 'dimensions': [{'id': key, 'label': key} for key in ids]}, None)
        material = json.loads(observed[0]['messages'][1]['content'])
        self.assertEqual((material['scoreScale']['minimum'], material['scoreScale']['maximum'], material['scoreScale']['passingScore']), (0, 4, 3))
        self.assertIn('0–4', observed[0]['messages'][0]['content'])
        self.assertNotIn('PRIVATE_PROCESS_REQUIREMENT', json.dumps(material))
        self.assertEqual(material['evaluationGoal'], 'correct answer')
        self.assertTrue(all(row['leftScore'] == row['rightScore'] == 4 for row in result['dimensions']))

    async def test_json_fence_or_explanation_does_not_invalidate_cited_judgement(self):
        async def invoke(body, _output):
            answer = {'status': 'PRODUCED', 'summary': '额外说明不改变判定',
                      'criteria': [{'id': 'one', 'passed': True, 'reason': '实际证据', 'evidenceRefs': ['/output'], 'confidence': 'high'}]}
            return {'content': '观察到状态 {"status":"COMPLETE"}。结论如下：\n```json\n' + json.dumps(answer) + '\n```', 'investigation': []}
        result = await judge_criteria({'evalCase': {'prompt': 'Task', 'rubric': [{'criterionId': 'one', 'scope': 'execution'}]},
            'evidence': {'status': 'completed', 'output': 'actual output', 'toolCalls': [], 'metadata': {}}},
            model={'modelId': 'controlled', 'providerId': 'controlled'}, invoke=invoke)
        self.assertTrue(result['passed'])

    async def test_answer_and_execution_have_independent_frozen_contexts(self):
        observed = []
        async def invoke(body, _output):
            observed.append(deepcopy(body))
            ids = body['payload']['requiredCriterionIds']
            return {'content': json.dumps({'criteria': [{'id': identifier, 'passed': True, 'reason': 'Observed', 'evidenceRefs': ['/output']} for identifier in ids]}),
                'investigation': [], 'receipt': {'role': 'criterion-judge'}}
        result = await judge_criteria({'evalCase': {'prompt': 'Task', 'rubric': [{'criterionId': 'answer', 'scope': 'answer'}, {'criterionId': 'execution', 'scope': 'execution'}]},
            'evidence': {'status': 'completed', 'output': 'answer', 'toolCalls': [{'name': 'private_tool', 'status': 'completed'}], 'metadata': {}}},
            model={'modelId': 'controlled', 'providerId': 'controlled'}, invoke=invoke)
        self.assertTrue(result['passed'])
        self.assertEqual(len(observed), 2)
        self.assertNotIn('toolCalls', observed[0]['resources'])
        self.assertIn('toolCalls', observed[1]['resources'])

    async def test_goal_quote_repair_cannot_change_a_judgement(self):
        class Model:
            adapter_id = 'controlled'
            attempts = 0
            async def complete(self, request):
                self.attempts += 1
                return {'content': json.dumps({'checks': [{'criterionIndex': 0, 'verdict': 'FAIL' if self.attempts == 1 else 'PASS',
                    'reason': 'Same reason', 'evidence': 'not present in the actual answer' if self.attempts == 1 else 'actual answer'}]})}
        model = Model()
        judge = ModelJudge('goal', {'providerId': 'controlled', 'modelId': 'controlled'}, adapter=model)
        with self.assertRaisesRegex(ValueError, '改变了原判定'):
            await judge.goal({'caseId': 'one', 'prompt': 'task', 'rubric': [{'description': 'goal'}]},
                {'status': 'completed', 'caseId': 'one', 'output': 'actual answer', 'metadata': {}, 'toolCalls': [], 'runtimeIdentityVerified': False}, None)
        self.assertEqual(model.attempts, 2)

    def test_quote_recovery_returns_real_span(self):
        answer = 'The **account balance** is 30.'
        quote = recover_quote(answer, 'The account balance ... is 30.')
        self.assertIn(quote, answer)
        self.assertIn('account balance', quote)
