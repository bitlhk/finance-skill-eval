import unittest

from migration.facts import input_issues


class ConversationalRuntimeInputTests(unittest.TestCase):
    def test_prose_plan_accepts_operator_tool_configuration(self):
        configuration = {'runtimeInputs': {'MEETINGROOM_BASE_URL': {'value': 'http://localhost:12365'},
            'MEETINGROOM_API_KEY': {'secretEnv': 'ACCEPTANCE_BUSINESS_KEY'}}}
        self.assertEqual(input_issues({}, configuration, complete=True), [])

    def test_explicit_declarations_keep_credential_and_required_validation(self):
        task = {'analysis': {'standardization': {'configurationInputs': [
            {'name': 'API_KEY', 'label': '服务凭证', 'required': True, 'sensitive': True}]}}}
        self.assertTrue(input_issues(task, {'runtimeInputs': {'API_KEY': {'value': 'not-a-reference'}}}))
        self.assertTrue(input_issues(task, {'runtimeInputs': {'UNKNOWN': {'value': 'x'}}}))
        self.assertTrue(input_issues(task, {}, complete=True))
        self.assertEqual(input_issues(task, {'runtimeInputs': {'API_KEY': {'secretEnv': 'SERVICE_KEY'}}}, complete=True), [])
