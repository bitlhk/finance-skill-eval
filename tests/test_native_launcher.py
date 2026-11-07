"""Exercise the native client against published contracts, without business services."""
import asyncio
from copy import deepcopy
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import os

import httpx

from runtime.launcher import RuntimeLauncher


ROOT = Path(__file__).resolve().parents[1] / 'contracts/runtime-launcher/examples'


def example(name):
    return json.loads((ROOT / name).read_text(encoding='utf-8'))


class NativeLauncherTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        source = example('instance.create.json')
        self.options = {'baseUrl': 'http://127.0.0.1:5000/deployments/builder-job-01-runtime/',
            'side': 'right', 'model': {'modelId': source['modelId'], 'parameters': {}},
            'variant': {'mode': 'skill_version', 'skillId': 'policy', 'version': 'r1'},
            'skillSet': {key: source[key] for key in ('skills', 'contentDigest')},
            'skill': None, 'environment': source['environment'], 'timeoutMs': 5000}
        self.calls, self.instances = [], 0
        self.evidence = example('execution.evidence.json')
        self.evidence['loadedSkills'] = [{'skillId': 'policy', 'version': 'r1'}]
        self.evidence['metadata'].update(contentDigest=source['contentDigest'],
            loadedSkillMembers=[{key: skill[key] for key in ('id', 'skillId', 'skillFile', 'version', 'artifactSha256')}
                                for skill in source['skills']])
        self.cleanup_status = 'RELEASED'
        self.multi_turn = False
        self.request = {'runId': 'run-01', 'side': 'right', 'evalCase': {'caseId': 'case-01', 'prompt': 'Assess'},
                        'model': self.options['model'], 'variant': self.options['variant']}

    async def wire(self, request):
        body = json.loads(request.content) if request.content else None
        self.calls.append((request.method, request.url.path, body, dict(request.headers)))
        if request.url.path.endswith('/v1/runtime-capabilities'):
            value = example('builder-capabilities.json')
            value['features']['processEvidence'] = True
            value['features']['multiTurn'] = self.multi_turn
            return httpx.Response(200, json=value)
        if request.method == 'DELETE':
            return httpx.Response(200, json={'cleanup': {'schemaVersion': 'finance.eval-cleanup-observation.v1',
                'instanceId': 'instance-01', 'status': self.cleanup_status,
                'observedAt': '2026-11-05T12:00:00Z', 'scope': 'THIS_INSTANCE'}})
        if request.method == 'POST' and request.url.path.endswith('/v1/runtime-instances'):
            self.instances += 1
            return httpx.Response(200, json=example('instance.ready.json'))
        if request.method == 'GET':
            return httpx.Response(200, json=example('instance.ready.json'))
        return httpx.Response(200, json=deepcopy(self.evidence))

    def launcher(self):
        return RuntimeLauncher(self.options, transport=httpx.MockTransport(self.wire))

    async def test_prepare_execute_and_release_have_one_owner(self):
        launcher = self.launcher()
        await launcher.prepare({'runId': 'run-01'})
        result = await launcher.execute(self.request)
        self.assertEqual(result['output'], self.evidence['output'])
        self.assertEqual(result['metadata']['executionMode'], 'runtime-launcher')
        await launcher.cleanup()
        self.assertEqual(launcher.finalization_evidence()['status'], 'RELEASED')
        self.assertIsNone(launcher.instance)
        self.assertEqual(len([item for item in self.calls if item[0] == 'DELETE']), 1)

    async def test_continuation_restores_owner_without_a_process_registry(self):
        state = None
        for action, inputs in (('prepare', {'runId': 'run-01'}), ('execute', self.request), ('cleanup', None)):
            launcher = self.launcher()
            if state:
                launcher.restore_state(state)
            result = await getattr(launcher, action)(inputs) if inputs is not None else await launcher.cleanup()
            state = launcher.export_state()
            if action == 'execute':
                self.assertEqual(result['output'], self.evidence['output'])
            if action == 'cleanup':
                self.assertEqual(launcher.finalization_evidence()['status'], 'RELEASED')
        self.assertEqual(self.instances, 1)

    async def test_invalid_execution_identity_is_never_accepted(self):
        launcher = self.launcher()
        await launcher.prepare({'runId': 'run-01'})
        self.evidence['caseId'] = 'other-case'
        with self.assertRaisesRegex(ValueError, 'requested case'):
            await launcher.execute(self.request)
        await launcher.cleanup()
        self.assertEqual(launcher.finalization_evidence()['status'], 'RELEASED')

    async def test_missing_process_is_a_runtime_contract_failure(self):
        launcher = self.launcher()
        await launcher.prepare({'runId': 'run-01'})
        self.evidence['metadata'].pop('process')
        with self.assertRaises(ValueError):
            await launcher.execute(self.request)
        await launcher.cleanup()

    async def test_process_exit_reports_real_failure_without_inventing_process_evidence(self):
        from evaluation.case_state import ExecutionFailure
        launcher = self.launcher()
        await launcher.prepare({'runId': 'run-01'})
        self.evidence.update(status='failed', runtimeIdentityVerified=False, streamCompleted=False,
                             error='OpenJiuwen session exited before terminal evidence (exit code 1): TimeoutError')
        self.evidence['metadata'] = {'runtimeFailure': {'kind': 'PROCESS_EXIT', 'exitCode': 1, 'errorType': 'TimeoutError'}}
        with self.assertRaisesRegex(ExecutionFailure, 'exit code 1.*TimeoutError') as error:
            await launcher.execute(self.request)
        self.assertEqual(error.exception.metadata['runtimeFailure']['errorType'], 'TimeoutError')
        self.assertNotIn('process', error.exception.metadata)
        await launcher.cleanup()

    async def test_multi_turn_process_records_are_projected_before_receipt_validation(self):
        from tasks.values import fingerprint
        self.multi_turn = True
        launcher = self.launcher()
        await launcher.prepare({'runId': 'run-01'})
        queries, outputs = ['Read the document', 'Summarize'], ['Read', 'Done']
        self.request['evalCase']['turns'] = [{'query': query, 'requiredTools': []} for query in queries]
        self.evidence['toolCalls'] = []
        self.evidence['output'] = 'Turn 1:\nRead\n\nTurn 2:\nDone'
        self.evidence['metadata']['conversation'] = {'sessionId': 'session', 'workspaceId': 'workspace', 'turns': [
            {'index': index, 'queryDigest': fingerprint(query), 'status': 'completed', 'output': output,
             'outputDigest': fingerprint(output), 'toolNames': ['read_document'] if index == 0 else []}
            for index, (query, output) in enumerate(zip(queries, outputs))]}
        result = await launcher.execute(self.request)
        self.assertEqual(result['toolCalls'], [{'name': 'read_document', 'status': 'completed'}])
        await launcher.cleanup()

    async def test_stop_after_failure_does_not_replay_or_start_another_case(self):
        self.options['stopAfterFailure'] = True
        launcher = self.launcher()
        await launcher.prepare({'runId': 'run-01'})
        self.evidence['status'], self.evidence['error'] = 'failed', 'business failure'
        result = await launcher.execute(self.request)
        self.assertEqual(result['status'], 'failed')
        before = len(self.calls)
        with self.assertRaises(Exception) as error:
            await launcher.execute({**self.request, 'evalCase': {'caseId': 'case-02', 'prompt': 'Next'}})
        self.assertEqual(error.exception.metadata['executionDisposition'], 'NOT_EXECUTED')
        self.assertEqual(len(self.calls), before)
        self.assertEqual(self.instances, 1)
        await launcher.cleanup()

    async def test_unconfirmed_release_is_not_reported_as_success(self):
        launcher = self.launcher()
        await launcher.prepare({'runId': 'run-01'})
        self.cleanup_status = 'UNKNOWN'
        with self.assertRaisesRegex(RuntimeError, '释放成功'):
            await launcher.cleanup()
        self.assertNotEqual(launcher.finalization_evidence()['status'], 'RELEASED')
        self.assertIsNotNone(launcher.instance)

    async def test_cancellation_during_execution_still_allows_explicit_cleanup(self):
        entered = asyncio.Event()
        original = self.wire
        async def wire(request):
            if request.url.path.endswith('/execute'):
                entered.set()
                await asyncio.Future()
            return await original(request)
        launcher = RuntimeLauncher(self.options, transport=httpx.MockTransport(wire))
        await launcher.prepare({'runId': 'run-01'})
        running = asyncio.create_task(launcher.execute(self.request))
        await entered.wait()
        running.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await running
        await launcher.cleanup()
        self.assertEqual(launcher.finalization_evidence()['status'], 'RELEASED')
