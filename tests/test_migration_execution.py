from copy import deepcopy
import unittest

from tasks.application_host import ExecutionHost, call, CapabilityError
from migration.execution import run, observation_scope
from migration.control import execute
from migration.artifacts import candidate
from migration.state import MigrationControlError


class ExecutionHostTests(unittest.TestCase):
    def test_waiting_task_does_not_block_another_task_or_consume_its_reply(self):
        def program(label):
            value = yield call('agent', {'label': label})
            return value
        host = ExecutionHost()
        first, second = host.start(program('one')), host.start(program('two'))
        with self.assertRaises(ValueError):
            host.advance(first['executionId'], second['token'], 'wrong')
        self.assertEqual(host.advance(second['executionId'], second['token'], 'two-result')['value'], 'two-result')
        self.assertEqual(host.advance(first['executionId'], first['token'], 'one-result')['value'], 'one-result')
        self.assertFalse(host.pending)

    def test_failed_capability_can_persist_cleanup_before_completion(self):
        def program():
            try:
                yield call('agent')
            except CapabilityError as error:
                yield call('save_interruption', error.detail, cleanup=True)
        host = ExecutionHost()
        pending = host.start(program())
        cleanup = host.advance(pending['executionId'], pending['token'], error={'message': 'Stopped', 'aborted': True})
        self.assertTrue(cleanup['cleanup'])
        self.assertTrue(cleanup['inputs']['aborted'])
        self.assertEqual(host.advance(cleanup['executionId'], cleanup['token'])['status'], 'done')
        self.assertFalse(host.pending)

    def test_discard_releases_only_the_matching_call_stack(self):
        closed = []
        def program():
            try:
                yield call('agent')
            finally:
                closed.append(True)
        host = ExecutionHost()
        pending = host.start(program())
        host.discard(pending['executionId'], 'wrong')
        self.assertFalse(closed)
        host.discard(pending['executionId'], pending['token'])
        self.assertEqual(closed, [True]);self.assertFalse(host.pending)


class ApplicationHarness:
    """Real Python application and transitions with controlled external capabilities."""
    def __init__(self, results, *, prepare=False):
        self.task = {'id': 'bundle-ab', 'goal': '保留原能力', 'target': 'openjiuwen', 'inputKind': 'agent_project',
            'currentCandidateId': None, 'candidates': [], 'runs': [], 'preparations': [],
            'configuration': {'modelId': 'model'}, 'suite': {'cases': []},
            'attempts': [{'id': 'attempt-ab', 'kind': 'CHAT', 'status': 'RUNNING', 'key': 'one',
                'baseCandidateId': None, 'agentRunId': 'agent-ab', 'sessionExecutionId': 'execution-ab',
                'startedAt': '2026-01-01T00:00:00Z', **({'prepareProject': True} if prepare else {})}]}
        self.snapshots = {'source': {'digest': 'old', 'members': [], 'files': {'main.py': 'original'}}}
        self.results, self.calls, self.agent_inputs = list(results), [], []
        self.facts = {'configurationDigest': 'configuration', 'planDigest': 'plan', 'frozenSuites': {}, 'runs': {}}

    def invoke(self, effect):
        name, p = effect['capability'], effect['inputs']
        self.calls.append(name)
        if name == 'load':
            return deepcopy(self.task)
        if name == 'observe':
            base = self.snapshots.get(self.task['currentCandidateId'], self.snapshots['source'])
            return {'source': self.snapshots['source'], 'base': deepcopy(base), 'facts': self.facts,
                'feedback': {}, 'evaluationIssues': [], 'reviewAvailable': True, 'checkpointRoot': 'persistent'}
        if name == 'transition':
            result = execute({'action': p['action'], 'task': self.task, 'attemptId': p['attemptId'],
                'inputs': {'facts': self.facts, 'persisted': True, 'inputDigest': 'input', **p['inputs']}})
            self.task = result['task']
            return deepcopy(result)
        if name == 'agent':
            self.agent_inputs.append(p['input'])
            result = self.results.pop(0)
            if isinstance(result, Exception):
                raise result
            return deepcopy(result)
        if name == 'freeze':
            return {'revision': {'digest': 'new', 'members': [], 'files': p['result']['files']}, 'executions': []}
        if name == 'diff':
            return []
        if name == 'save_snapshot':
            self.snapshots[p['id']] = deepcopy(p['revision'])
        if name == 'evaluation_view':
            return None
        if name == 'evaluate':
            self.task['runs'].append({'id': 'evaluation-ab', 'phase': 'development', 'status': 'PASSED'})
            next(item for item in self.task['attempts'] if item['id'] == p['attemptId'])['runId'] = 'evaluation-ab'
        if name == 'evaluation_result':
            return {'run': self.task['runs'][-1], 'task': self.task, 'before': None, 'after': {},
                'facts': self.facts, 'repetitionsComplete': True}
        if name == 'failure_facts':
            return {'retryInteraction': False}

    def run(self):
        host = ExecutionHost()
        effect = host.start(run({'taskId': self.task['id'], 'attemptId': 'attempt-ab'}))
        while effect['status'] == 'call':
            try:
                value, error = self.invoke(effect), None
            except Exception as failure:
                value, error = None, getattr(failure, 'detail', {'message': str(failure), 'name': type(failure).__name__})
            effect = host.advance(effect['executionId'], effect['token'], value, error)
        return self.task


class MigrationExecutionTests(unittest.TestCase):
    def test_repeated_tool_registration_preserves_version_but_contract_changes_create_one(self):
        tools=[{'toolId':'cli','form':'CLI','files':['main.py'],'entrypoint':'main.py'}]
        for changed in (False,True):
            with self.subTest(changed=changed):
                delivery={'services':[],'tools':deepcopy(tools)}
                if changed:
                    delivery['tools'][0]['configuration']='new runtime requirement'
                harness=ApplicationHarness([{'status':'PRODUCED','message':'登记已核对','files':{'main.py':'fixed'},'deliveryTools':delivery}])
                harness.task.update(currentCandidateId='candidate-existing',candidates=[{'id':'candidate-existing','digest':'new','services':[],'tools':tools}])
                harness.task['attempts'][0]['baseCandidateId']='candidate-existing'
                harness.snapshots['candidate-existing']={'digest':'new','members':[],'files':{'main.py':'fixed'}}
                task=harness.run()
                self.assertEqual(len(task['candidates']),2 if changed else 1)
                self.assertEqual(task['currentCandidateId']=='candidate-existing',not changed)
                self.assertEqual('save_snapshot' in harness.calls,changed)

    def test_question_wait_preserves_same_attempt_and_never_freezes_or_evaluates(self):
        harness = ApplicationHarness([{'status': 'WAITING', 'interactions': [{'interaction_id': 'q'}]}])
        task = harness.run()
        self.assertEqual(task['attempts'][0]['status'], 'WAITING')
        self.assertEqual(task['attempts'][0]['waitingInteractionIds'], ['q'])
        self.assertNotIn('freeze', harness.calls);self.assertNotIn('evaluate', harness.calls)

    def test_preparation_publishes_source_copy_without_falsely_creating_business_acceptance(self):
        harness = ApplicationHarness([{'status': 'PRODUCED', 'message': '已读取工程', 'files': {'main.py': 'prepared'}}], prepare=True)
        task = harness.run()
        self.assertEqual(task['attempts'][0]['status'], 'COMPLETED')
        self.assertEqual(task['preparations'][0]['baselineStatus'], 'NOT_EVALUATED')
        self.assertEqual(harness.snapshots[task['preparations'][0]['id']]['files']['main.py'], 'prepared')
        self.assertFalse(task['candidates']);self.assertFalse(task['runs'])

    def test_evaluation_continues_same_task_in_python_without_restarting_the_original_attempt(self):
        harness = ApplicationHarness([
            {'status': 'PRODUCED', 'message': '评测当前版本', 'files': {'main.py': 'fixed'}, 'evaluationRequested': True},
            {'status': 'PRODUCED', 'message': '结果已解释', 'files': {'main.py': 'fixed'}},
        ])
        task = harness.run()
        self.assertEqual([item['status'] for item in task['attempts']], ['COMPLETED', 'COMPLETED'])
        self.assertEqual(harness.calls.count('evaluate'), 1)
        self.assertEqual(harness.calls.count('agent'), 2)
        self.assertTrue(harness.agent_inputs[1]['agentFollowup'])
        self.assertNotEqual(harness.agent_inputs[1]['taskSession']['executionId'], 'execution-ab')
        self.assertEqual(len(task['candidates']), 1)

    def test_shutdown_is_interruption_and_does_not_publish_an_unreturned_workspace(self):
        harness = ApplicationHarness([CapabilityError({'message': 'Shutdown', 'name': 'Error', 'aborted': True, 'closing': True})])
        task = harness.run()
        self.assertEqual(task['attempts'][0]['status'], 'INTERRUPTED')
        self.assertFalse(task['candidates']);self.assertNotIn('freeze', harness.calls)

    def test_holdout_observations_never_enter_agent_scope_and_explicit_old_run_is_preserved(self):
        harness = ApplicationHarness([])
        harness.task['runs'] = [{'id': str(index), 'phase': 'development', 'status': 'PASSED'} for index in range(8)]
        harness.task['runs'].append({'id': 'secret', 'phase': 'holdout', 'status': 'PASSED'})
        current = harness.task['attempts'][0];current['runId'] = '0'
        scope = observation_scope(harness.task, current)
        self.assertNotIn('secret', scope['runIds']);self.assertIn('0', scope['runIds'])

    def test_tool_forms_are_preserved_and_invalid_mcp_delivery_is_rejected(self):
        harness = ApplicationHarness([])
        task, current = harness.task, harness.task['attempts'][0]
        result = {'message': '调整工具', 'deliveryTools': {'services': [],
            'tools': [{'toolId': 'cli', 'form': 'CLI', 'files': ['tool.py'], 'entrypoint': 'tool --json'}]}}
        revision = {'digest': 'new', 'members': [], 'files': {'tool.py': 'code'}}
        value = candidate(task, current, result, revision, [], [])
        self.assertEqual(value['tools'][0]['form'], 'CLI')
        result['deliveryTools']['tools'][0].update(form='MCP', entrypoint='remote_tool')
        with self.assertRaises(MigrationControlError):
            candidate(task, current, result, revision, [], [])
