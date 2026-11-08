import base64
import copy
import hashlib
import io
import tempfile
import unittest
import zipfile
import json
import os
import sys
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch, AsyncMock, Mock
from types import SimpleNamespace
from .bundle_runtime import files_digest, verify_bundle_integrity
from .skill_set import hydrate_skill_set
from .instance_manager import InstanceManager
from .bundle_agent import collect_candidate
from .bundle_agent import run_bundle
from .bundle_agent import citation_errors
from .bundle_agent import correct_result_fields
from .bundle_agent import analysis_sample_errors
from .bundle_agent import verify_delivery_contracts
from .bundle_agent import preparation_from_prose
from .bundle_agent import preparation_answer
from .bundle_agent import discussion_manifest_feedback
from .agent_protocol import MAX_ITERATION_SENTINEL
from .execution_paths import execution_paths
from .migration_checkpoint import MigrationCheckpoint


class PreparationProseTests(unittest.TestCase):
    def test_only_completed_explanation_is_retained_without_inventing_inventory(self):
        result = preparation_from_prose({'result_type': 'answer', 'output': '入口待核对。'}, lambda value: value)
        self.assertEqual(result['preparation']['summary'], '入口待核对。')
        self.assertEqual(result['preparation']['skills'], [])
        self.assertIn('未单独提取结构化清单', result['preparation']['missing'][0])
        for invalid in ({'result_type':'error','output':'失败'}, {'result_type':'interrupt','output':'等待'},
                        {'result_type':'answer','output':''}, {'result_type':'answer','output':MAX_ITERATION_SENTINEL}):
            self.assertIsNone(preparation_from_prose(invalid, lambda value: value))

    def test_json_example_in_prose_is_not_mistaken_for_submission(self):
        answer = '已检查入口；示例响应为 {"status":"PRODUCED"}，仍需核对服务。'
        result = preparation_answer({'result_type':'answer','output':answer}, lambda value: value)
        self.assertEqual(result['preparation']['summary'], answer)
        self.assertEqual(result['preparation']['skills'], [])
        explicit = {'status':'ABSTAINED','reason':'缺少运行信息'}
        self.assertEqual(preparation_answer({'result_type':'answer','output':'```json\n'+json.dumps(explicit)+'\n```'}, lambda value: value), explicit)
        self.assertIsNone(preparation_answer({'result_type':'error','output':'失败'}, lambda value: value))

    def test_manifest_includes_bound_review_but_not_case_evidence(self):
        feedback={'developmentEvaluations':[{'runId':'run-1','cases':['PRIVATE_CASE']}],
                  'diagnosis':{'status':'PROPOSED','hypothesis':{'issue':'检查工具返回值'}},
                  'standardizationReview':{'candidateId':'candidate-1','candidateDigest':'abc',
                                           'review':{'issues':['需要修复']}}}
        manifest=discussion_manifest_feedback(feedback)
        self.assertEqual(manifest['standardizationReview'],feedback['standardizationReview'])
        self.assertEqual(manifest['diagnosis'],feedback['diagnosis'])
        self.assertNotIn('PRIVATE_CASE',json.dumps(manifest))


def fixture():
    files = {'skills/budget/SKILL.md': b'---\nname: budget\ndescription: Budget\n---\nBudget body',
             'skills/rules/SKILL.md': b'---\nname: rules\ndescription: Rules\n---\nRules body',
             'shared/data.bin': bytes([0, 255, 128])}
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, 'w') as zipped:
        for name, content in files.items():
            zipped.writestr(name, content)
    archive = buffer.getvalue()
    members = [{'id': name, 'skillId': name, 'version': 'r1', 'skillFile': 'skills/' + name + '/SKILL.md',
                'artifactSha256': files_digest({p: content for p, content in files.items() if p.startswith('skills/' + name + '/')})}
               for name in ['budget', 'rules']]
    skills=[{**member,'instructions':files[member['skillFile']].decode()} for member in members]
    return files, {'schemaVersion':'finance.runtime-instance.v1','runId':'bundle-run','side':'right','modelId':'test',
        'skills':skills,'contentDigest':files_digest(files),'assets':{'shared/data.bin':base64.b64encode(files['shared/data.bin']).decode()},
        'environment':{},'configuration':{},'secrets':{'mode':'inline','values':{}},'limits':{'timeoutMs':10000}}



class BundleRuntimeTest(unittest.TestCase):
    @unittest.skipUnless(os.name == 'nt', 'Windows extended-path identity')
    def test_windows_absolute_and_extended_paths_share_the_same_workspace_boundary(self):
        from .workspace_paths import analysis_path, candidate_path
        with tempfile.TemporaryDirectory() as directory:
            plain = Path(directory).resolve()
            extended = Path('\\\\?\\' + str(plain))
            expected = extended / 'candidate' / 'SKILL.md'
            self.assertEqual(analysis_path(extended, str(plain / 'candidate/SKILL.md')), expected)
            self.assertEqual(candidate_path(extended / 'candidate', str(plain / 'candidate/SKILL.md')), expected)
            self.assertEqual(candidate_path(extended / 'candidate', 'candidate/SKILL.md'), expected)
            for value in (str(plain.parent / 'outside.py'), str(plain / 'source/SKILL.md'), '../source/SKILL.md'):
                with self.assertRaises(ValueError):
                    candidate_path(extended / 'candidate', value)

    def test_source_corrections_match_runtime_capability_evidence_and_fields(self):
        files = {'tool.py': base64.b64encode(b'first\nsecond').decode()}
        draft = {'analysis': {'plan': {'requiredCapabilities': [{'evidence': [{'path': 'old', 'line': 9, 'detail': 'old'}]}]},
                              'evidence': [{'path': 'old', 'snippet': 'old'}]}}
        source = {'sourcePath': 'tool.py', 'startLine': 2, 'endLine': 2}
        result = correct_result_fields(draft, [
            {'path': '/analysis/plan/requiredCapabilities/0/evidence/0', **source},
            {'path': '/analysis/evidence/0/path', **source},
            {'path': '/analysis/evidence/0/snippet', **source}], files)
        self.assertEqual(result['analysis']['plan']['requiredCapabilities'][0]['evidence'][0],
                         {'path': 'tool.py', 'line': 2, 'detail': 'second'})
        self.assertEqual(result['analysis']['evidence'][0], {'path': 'tool.py', 'snippet': 'second'})
        self.assertEqual(draft['analysis']['evidence'][0]['path'], 'old')

    def test_targeted_corrections_preserve_other_findings_and_quote_actual_source(self):
        original = {'analysis': {'summary': 'Keep this finding', 'evidence': [{'path': 'SKILL.md', 'snippet': 'wrong'}], 'coverage': {}}}
        files = {'SKILL.md': base64.b64encode(b'name: meetingroom\\_modify\r\noriginal second line').decode()}
        result = correct_result_fields(original, [
            {'path': '/analysis/coverage/blocking', 'value': False},
            {'path': '/analysis/evidence/0', 'sourcePath': 'SKILL.md', 'startLine': 1, 'endLine': 2}], files)
        self.assertEqual(result['analysis']['summary'], original['analysis']['summary'])
        self.assertEqual(result['analysis']['evidence'][0]['snippet'], 'name: meetingroom\\_modify\noriginal second line')
        self.assertEqual(original['analysis']['evidence'][0]['snippet'], 'wrong')
        for source, first, last in [('../outside', 1, 1), ('SKILL.md', 0, 1), ('SKILL.md', 1, 3)]:
            with self.assertRaises(ValueError):
                correct_result_fields(original, [{'path': '/analysis/evidence/0', 'sourcePath': source, 'startLine': first, 'endLine': last}], files)

    def test_citations_preserve_escapes_and_reject_noncontiguous_or_ambiguous_text(self):
        files = {'a/SKILL.md': 'name: meetingroom\\_modify\r\nfirst\r\nsecond', 'b/SKILL.md': 'Other'}
        self.assertEqual(citation_errors({'evidence': [{'path': 'source/a/SKILL.md', 'snippet': 'first\nsecond'}]}, files), [])
        for path, snippet in [('a/SKILL.md', 'meetingroom_modify'), ('a/SKILL.md', 'first...second'), ('SKILL.md', 'Other')]:
            self.assertEqual(len(citation_errors({'evidence': [{'path': path, 'snippet': snippet}]}, files)), 1)

    def test_more_than_ten_skills_are_loaded_in_one_instance(self):
        _, request = fixture()
        files, skills = {}, []
        for i in range(11):
            name = f'skill-{i}'
            entry, instructions = f'skills/{name}/SKILL.md', f'Instructions for {name}'
            files[entry] = instructions.encode()
            skills.append({'id': name, 'skillId': name, 'version': 'r1', 'skillFile': entry,
                           'instructions': instructions, 'artifactSha256': files_digest({entry: files[entry]})})
        request.update(skills=skills, assets={}, contentDigest=files_digest(files))
        manager = InstanceManager()
        instance = manager.create(request, 'many-skills-key')
        body = manager.execution(instance['instanceId'], {'schemaVersion': 'finance.skill-eval.runtime-case.v1', 'caseId': 'case', 'query': 'use skills', 'workspaceFiles': []})
        self.assertEqual(len(body['skill']['bundleMembers']), 11)
        self.assertEqual(body['bundle']['digest'], files_digest(files))

    def test_one_member_uses_the_same_hydration_and_instance_contract(self):
        files, request = fixture()
        del files['skills/rules/SKILL.md']
        request['skills'] = request['skills'][:1]
        request['contentDigest']=files_digest(files)
        manager = InstanceManager()
        instance = manager.create(request, 'single-key')
        body = manager.execution(instance['instanceId'], {'schemaVersion': 'finance.skill-eval.runtime-case.v1', 'caseId': 'case', 'query': 'use budget', 'workspaceFiles': []})
        self.assertEqual(len(body['skill']['bundleMembers']), 1)
        self.assertEqual(body['bundle']['digest'], files_digest(files))

    def test_root_skill_accepts_optional_shared_assets_without_project_layout(self):
        instructions='Root Skill instructions'
        files={'SKILL.md':instructions.encode(),'rules.json':b'{"limit":100}'}
        request={'skills':[{'id':'root','skillId':'root','version':'r1','skillFile':'SKILL.md','instructions':instructions,
                           'artifactSha256':files_digest({'SKILL.md':instructions.encode()})}],
                 'assets':{'rules.json':base64.b64encode(files['rules.json']).decode()},'contentDigest':files_digest(files)}
        hydrate_skill_set(request,InstanceManager())
        self.assertEqual(request['skill']['files']['rules.json'],'{"limit":100}')

    def test_rejects_repaired_workspace_copy_even_when_loaded_package_is_unchanged(self):
        skill = {'bundleMembers': [{'skillId': 'test'}],
                 'files': {'shared/review.py': 'from decimal import ArithmeticError\n',
                           'fixtures/budgets.json': '{}'},
                 'binaryFiles': {'shared/data.bin': base64.b64encode(b'\0\xff').decode()}}
        inputs = [{'path': 'fixtures/budgets.json', 'content': '{"case":true}'}]
        with ExitStack() as stack:
            workspace, root, _ = execution_paths(stack, {}, skill, inputs)
            verify_bundle_integrity(skill, root, workspace, inputs)
            copied = workspace / 'shared/review.py'
            copied.parent.mkdir()
            copied.write_bytes((root / 'shared/review.py').read_bytes())
            verify_bundle_integrity(skill, root, workspace, inputs)
            copied.write_text('from decimal import Decimal\n', encoding='utf-8')
            with self.assertRaisesRegex(RuntimeError, 'Frozen bundle copy was modified'):
                verify_bundle_integrity(skill, root, workspace, inputs)
            self.assertEqual((root / 'shared/review.py').read_text(), skill['files']['shared/review.py'])
            copied.write_bytes((root / 'shared/review.py').read_bytes())
            (root / 'shared/data.bin').write_bytes(b'changed')
            with self.assertRaisesRegex(RuntimeError, 'Loaded bundle files were modified'):
                verify_bundle_integrity(skill, root, workspace, inputs)

    def test_runtime_materialization_preserves_windows_line_endings_and_binary(self):
        files, request = fixture()
        hydrate_skill_set(request, InstanceManager())
        skill = request['skill']
        skill['files']['shared/windows.txt'] = 'first\r\nsecond\r\n'
        with ExitStack() as stack:
            _, root, _ = execution_paths(stack, {}, skill)
            self.assertEqual((root / 'shared/windows.txt').read_bytes(), b'first\r\nsecond\r\n')
            self.assertEqual((root / 'shared/data.bin').read_bytes(), files['shared/data.bin'])

    def test_real_archive_preserves_all_members_shared_binary_and_execution_identity(self):
        files, request = fixture()
        manager = InstanceManager()
        instance = manager.create(request, 'key')
        body = manager.execution(instance['instanceId'], {'schemaVersion': 'finance.skill-eval.runtime-case.v1', 'caseId': 'case', 'query': 'use both', 'workspaceFiles': []})
        self.assertEqual(len(body['skill']['bundleMembers']), 2)
        self.assertEqual(body['skill']['files']['skills/rules/SKILL.md'], files['skills/rules/SKILL.md'].decode())
        self.assertEqual(base64.b64decode(body['skill']['binaryFiles']['shared/data.bin']), files['shared/data.bin'])
        self.assertEqual(body['bundle']['digest'], files_digest(files))
        self.assertEqual(instance['instanceId'], manager.create(request, 'key')['instanceId'])

    def test_rejects_missing_member_and_forged_content_before_execution(self):
        for mutation in ['missing', 'digest', 'entry', 'version']:
            _, request = fixture()
            if mutation == 'missing':
                request['skills'].pop()
            elif mutation == 'digest':
                request['skills'][0]['artifactSha256'] = 'a' * 64
            elif mutation == 'version':
                request['skills'][0]['version'] = ''
            else:
                request['entryInstructionsFile'] = '../outside'
            with self.assertRaises(ValueError, msg=mutation):
                hydrate_skill_set(request, InstanceManager())

    def test_full_candidate_collection_keeps_skill_directory_and_unchanged_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files, _ = fixture()
            for name, content in files.items():
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(content)
            collected = collect_candidate(root)
            self.assertEqual(set(collected), set(files))
            self.assertEqual(base64.b64decode(collected['shared/data.bin']), files['shared/data.bin'])


class BundleAgentWorkspaceTest(unittest.IsolatedAsyncioTestCase):
    def test_candidate_collection_skips_generated_caches_and_environment(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'SKILL.md').write_text('business', encoding='utf-8')
            for name in ('.pytest_cache', '.venv', '__pycache__'):
                (root / name).mkdir()
                (root / name / 'cache.txt').write_text('generated', encoding='utf-8')
            (root / 'generated.pyc').write_bytes(b'cache')
            self.assertEqual(set(collect_candidate(root)), {'SKILL.md'})

    async def test_delivery_reuses_shared_mcp_service_and_preserves_individual_results(self):
        delivery = {'tools': [
            {'toolId': 'a', 'form': 'MCP', 'entrypoint': 'first'},
            {'toolId': 'b', 'form': 'MCP', 'entrypoint': 'second'},
            {'toolId': 'c', 'form': 'SCRIPT', 'entrypoint': 'script.py'}],
            'services': [{'toolNames': ['first', 'second'], 'start': ['server'], 'prepare': ['install']}]}
        suite = AsyncMock(return_value={'passed': False, 'results': [
            {'toolId': 'a', 'passed': True, 'callExecuted': False, 'runtimeDependenciesPending': ['identity']},
            {'toolId': 'b', 'passed': False, 'error': 'not advertised'}]})
        single = AsyncMock(return_value={'passed': True, 'callExecuted': True})
        result = await verify_delivery_contracts(Path('.'), {}, delivery, single, suite, str)
        suite.assert_awaited_once()
        self.assertEqual(suite.await_args.args[2], ['a', 'b'])
        single.assert_awaited_once()
        self.assertEqual([(row['toolId'], row['passed'], row['callExecuted']) for row in result],
                         [('a', True, False), ('b', False, False), ('c', True, True)])
        self.assertIn('identity', result[0]['detail'])
        self.assertIn('not advertised', result[1]['detail'])

    async def test_failed_mcp_service_never_marks_unchecked_tools_passed(self):
        delivery = {'tools': [{'toolId': 'a', 'form': 'MCP', 'entrypoint': 'first'}],
                    'services': [{'toolNames': ['first'], 'start': ['server']}]}
        result = await verify_delivery_contracts(Path('.'), {}, delivery, AsyncMock(),
            AsyncMock(return_value={'passed': False, 'error': 'service failed', 'results': []}), str)
        self.assertEqual(result, [{'toolId': 'a', 'passed': False, 'callExecuted': False, 'detail': 'service failed'}])
    async def test_cli_is_not_executed_as_a_json_stdin_script(self):
        from integrations.openjiuwen.migration_tools import _contract_test
        with tempfile.TemporaryDirectory() as folder:
            result = await _contract_test(Path(folder), {'git': {'form': 'CLI'}}, 'git', 'git')
        self.assertFalse(result['callExecuted'])
        self.assertIn('WAIT_RUNTIME_CLI', result['note'])

    def test_analysis_rejects_mismatched_script_envelope_before_generation(self):
        contract = {'inputSchema': {'type': 'object', 'properties': {}, 'additionalProperties': False},
                    'outputSchema': {}, 'sampleInput': {'tool': 'lookup', 'user_id': 'example', 'args': {}}, 'sampleReason': ''}
        analysis = {'diagnosis': {'tools': [{'id': 'lookup', 'name': 'lookup', 'language': 'python'}]},
                    'standardization': {'tools': [{'toolId': 'lookup', 'form': 'SCRIPT', 'contract': contract}]}}
        self.assertIn('lookup: sampleInput', analysis_sample_errors(analysis)[0])
        contract['inputSchema'] = {'type': 'object', 'required': ['tool', 'user_id', 'args'],
            'properties': {'tool': {'const': 'lookup'}, 'user_id': {'type': 'string'},
                           'args': {'type': 'object', 'additionalProperties': False}}, 'additionalProperties': False}
        self.assertEqual(analysis_sample_errors(analysis), [])
        contract['sampleInput'] = None
        contract['sampleReason'] = 'No safe invocation available'
        self.assertEqual(analysis_sample_errors(analysis), [])

    async def test_main_uses_natural_output_without_phase_submission_or_format_repair(self):
        files, _ = fixture()
        answer = '已检查工程；示例响应 {"status":"PRODUCED"}，仍需核对服务。'
        owner = self
        def factory(**options):
            names = {tool.card.name for tool in options['tools']}
            owner.assertFalse(names & {'submit_result', 'record_result', 'correct_result'})
            owner.assertIn('run_project_command', names)
            async def stream(_):
                yield {'type': 'answer', 'payload': {'output': answer, 'result_type': 'answer'}}
            return SimpleNamespace(stream=stream)
        result = await self.run_main_factory(factory, files)
        self.assertEqual(result['status'], 'PRODUCED', result)
        self.assertEqual(result['payload']['message'], answer)
        self.assertNotIn('preparation', result['payload'])
        self.assertNotIn('delivery', result['payload'])

    async def test_main_retains_unavailable_engineering_receipt_without_claiming_execution(self):
        files, _ = fixture()
        owner = self
        def factory(**options):
            command = next(tool for tool in options['tools'] if tool.card.name == 'run_project_command')
            async def stream(_):
                result = await command.invoke({'command': ['python', 'main.py'], 'cwd': None, 'timeout_seconds': None})
                owner.assertEqual(result['cwd'], '.')
                owner.assertEqual(result['status'], 'UNAVAILABLE')
                yield {'type': 'answer', 'payload': {'output': '已保留缺少执行环境的检查记录，不代表业务通过。'}}
            return SimpleNamespace(stream=stream)
        with patch.dict(os.environ, {'FINANCE_EVAL_PROJECT_EXECUTION_IMAGE': ''}):
            result = await self.run_main_factory(factory, files)
        self.assertEqual(result['status'], 'PRODUCED', result)
        self.assertEqual(result['payload']['executions'][0]['status'], 'UNAVAILABLE')

    async def test_native_main_requests_single_evaluation_without_an_optimization_baseline(self):
        await self.check_native_single_evaluation(False)

    async def test_native_evaluation_followup_can_retest_without_starting_optimization(self):
        await self.check_native_single_evaluation(True)

    async def test_text_compatibility_main_can_request_evaluation_through_actual_sdk(self):
        await self.check_native_single_evaluation(True, compatibility=True)

    async def test_sdk_tool_argument_error_returns_to_main_without_ending_the_task(self):
        await self.check_native_single_evaluation(True, compatibility=True, invalid_first=True)

    async def check_native_single_evaluation(self, followup, compatibility=False, invalid_first=False):
        import httpx
        from openai import AsyncOpenAI
        from openjiuwen.core.foundation.llm import init_model
        from openjiuwen.core.session.checkpointer import CheckpointerFactory
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        self.addCleanup(sys.path.pop, 0)
        calls = []
        async def respond(request):
            call = json.loads(request.content)
            calls.append(call)
            if compatibility:
                text=('{"tool":"run_project_command","arguments":{}}' if invalid_first and len(calls)==1 else
                      '{"tool":"request_development_evaluation","arguments":{}}')
                return httpx.Response(200,json={'id':'evaluation','object':'chat.completion','created':0,'model':'fixture',
                    'choices':[{'index':0,'message':{'role':'assistant','content':text},'finish_reason':'stop'}]})
            chunk = {'id': 'evaluation', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'fixture',
                'choices': [{'index': 0, 'delta': {'role': 'assistant', 'tool_calls': [{'index': 0,
                    'id': 'single-evaluation', 'type': 'function', 'function': {'name': 'request_development_evaluation',
                    'arguments': '{}'}}]}, 'finish_reason': 'tool_calls'}]}
            return httpx.Response(200, headers={'content-type': 'text/event-stream'},
                text='data: ' + json.dumps(chunk) + '\n\ndata: [DONE]\n\n')
        previous = CheckpointerFactory._default_checkpointer
        try:
            with tempfile.TemporaryDirectory() as directory:
                config = Path(directory) / 'config.json'
                config.write_text('{}', encoding='utf-8')
                files, _ = fixture()
                encoded = {name: base64.b64encode(content).decode() for name, content in files.items()}
                body = {'runId': 'fixture', 'assetDigest': files_digest(files), 'files': encoded,
                    'model': {'modelId': 'fixture'}, 'checkpointRoot': directory, 'taskSession': {},
                    'correlation': {'taskId': 'bundle-1234', 'attemptId': 'attempt-1234'},
                    'bundle': {'mode': 'CHAT', 'agentFollowup': followup, 'source': {'files': encoded}, 'evaluationAvailability': {'ready': True}}}
                async with AsyncOpenAI(api_key='fixture-key', base_url='https://fixture.invalid/v1',
                        http_client=httpx.AsyncClient(transport=httpx.MockTransport(respond))) as client:
                    model = init_model('OpenAI', 'fixture', 'fixture-key', 'https://fixture.invalid/v1')
                    model._client._create_async_openai_client = lambda timeout=None: client
                    with patch.dict(os.environ, {'FINANCE_RUNTIME_CONFIG': str(config),
                            'FINANCE_EVAL_JUDGE_BASE_URL': '', 'FINANCE_EVAL_JUDGE_API_KEY': ''}), \
                            patch('model_config.resolve_model', return_value={'apiKey': 'fixture-key', 'baseUrl': 'https://fixture.invalid/v1',
                                'supportsTools':not compatibility,'supportsStreaming':not compatibility}), \
                            patch('model_config.request_settings', return_value={'model_name': 'fixture'}), \
                            patch('openjiuwen.core.foundation.llm.init_model', return_value=model):
                        protocol = io.StringIO()
                        await run_bundle(body, protocol)
                result = next(json.loads(line)['result'] for line in protocol.getvalue().splitlines() if 'result' in json.loads(line))
                self.assertEqual(result['status'], 'PRODUCED', result)
                self.assertTrue(result['payload']['evaluationRequested'])
                self.assertNotIn('optimizationRequest', result['payload'])
                if compatibility:
                    self.assertNotIn('tools',calls[0])
                    self.assertIn('request_development_evaluation',calls[0]['messages'][0]['content'])
                else:
                    definitions = {tool['function']['name']: tool['function']['parameters'] for tool in calls[0]['tools']}
                    self.assertEqual(definitions['request_development_evaluation']['properties'], {})
                    if followup:
                        self.assertNotIn('request_optimization', definitions)
                    else:
                        self.assertEqual(set(definitions['request_optimization']['required']), {'baselineRunId', 'goal', 'maxRounds', 'targetPassRate'})
                self.assertEqual(len(calls), 2 if invalid_first else 1)
                if invalid_first:
                    self.assertTrue(any(json.loads(line).get('activity',{}).get('kind')=='tool_error' for line in protocol.getvalue().splitlines()))
        finally:
            CheckpointerFactory.set_default_checkpointer(previous)

    async def run_main_factory(self, factory, files):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        self.addCleanup(sys.path.pop, 0)
        encoded = {name: base64.b64encode(content).decode() for name, content in files.items()}
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text('{}', encoding='utf-8')
            protocol = io.StringIO()
            body = {'runId': 'fixture', 'assetDigest': files_digest(files), 'files': encoded,
                    'model': {'modelId': 'fixture'}, 'bundle': {'mode': 'CHAT', 'source': {'files': encoded}}}
            with patch.dict(os.environ, {'FINANCE_RUNTIME_CONFIG': str(config)}), \
                    patch('model_config.resolve_model', return_value={'apiKey': 'fixture', 'baseUrl': 'http://localhost/unused', 'supportsTools':True}), \
                    patch('model_config.request_settings', return_value={'model_name': 'fixture'}), \
                    patch('model_config.bind_agent_request_extensions', side_effect=lambda model, *_: model), \
                    patch('openjiuwen.core.foundation.llm.init_model', return_value=object()), \
                    patch('openjiuwen.harness.factory.create_deep_agent', side_effect=factory):
                await run_bundle(body, protocol)
            return next(json.loads(line)['result'] for line in protocol.getvalue().splitlines() if 'result' in json.loads(line))

    async def test_real_file_tools_edit_multiple_members_but_reject_source_writes(self):
        await self.check_combined_file_tools(False)

    async def test_migration_can_run_project_tests_in_isolated_execution(self):
        await self.check_combined_file_tools(False, mode='CHAT')

    async def test_one_adjustment_agent_edits_documents_and_tool_with_source_readonly(self):
        await self.check_combined_file_tools(True)

    async def test_agent_can_replace_fully_read_empty_file_without_losing_content(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        self.addCleanup(sys.path.pop, 0)
        from openjiuwen.harness.tools import WriteFileTool, ReadFileTool
        files, _ = fixture()
        files['shared/empty.py'] = b''
        encoded = {name: base64.b64encode(content).decode() for name, content in files.items()}
        owner = self
        def factory(**options):
            root = Path(options['workspace'])
            writer = next(tool for tool in options['tools'] if isinstance(tool, WriteFileTool))
            reader = next(tool for tool in options['tools'] if isinstance(tool, ReadFileTool))
            async def stream(_):
                target = root / 'candidate/shared/empty.py'
                owner.assertTrue((await reader.invoke({'file_path': 'candidate/shared/empty.py'})).success)
                written = await writer.invoke({'file_path': 'candidate/shared/empty.py', 'content': 'value = 1\n'})
                owner.assertTrue(written.success, str(written))
                owner.assertEqual(target.read_text(encoding='utf-8'), 'value = 1\n')
                owner.assertFalse((root / 'candidate/candidate').exists())
                owner.assertFalse((await writer.invoke({'file_path': 'source/shared/empty.py', 'content': 'forbidden'})).success)
                owner.assertFalse((await writer.invoke({'file_path': 'task/manifest.json', 'content': 'forbidden'})).success)
                yield {'type': 'answer', 'payload': {'output': json.dumps({'status': 'PRODUCED', 'delivery': {'summary': 'updated', 'services': []}})}}
            return SimpleNamespace(stream=stream)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text('{}', encoding='utf-8')
            body = {'runId': 'empty', 'assetDigest': files_digest(files), 'files': encoded,
                    'model': {'modelId': 'fixture'}, 'bundle': {'mode': 'CHAT', 'source': {'files': encoded}}}
            protocol = io.StringIO()
            with patch.dict(os.environ, {'FINANCE_RUNTIME_CONFIG': str(config)}), \
                    patch('model_config.resolve_model', return_value={'apiKey': 'fixture', 'baseUrl': 'http://localhost/unused', 'supportsTools':True}), \
                    patch('model_config.request_settings', return_value={'model_name': 'fixture'}), \
                    patch('model_config.bind_agent_request_extensions', side_effect=lambda model, *_: model), \
                    patch('openjiuwen.core.foundation.llm.init_model', return_value=object()), \
                    patch('openjiuwen.harness.factory.create_deep_agent', side_effect=factory):
                await run_bundle(body, protocol)
            result = next(json.loads(line)['result'] for line in protocol.getvalue().splitlines() if 'result' in json.loads(line))
            self.assertEqual(result['status'], 'PRODUCED', result)
            self.assertEqual(base64.b64decode(result['files']['shared/empty.py']), b'value = 1\n')

    async def test_interrupted_engineering_draft_resumes_only_for_matching_input(self):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        self.addCleanup(sys.path.pop, 0)
        from openjiuwen.harness.tools import WriteFileTool, ReadFileTool
        files, _ = fixture()
        encoded = {name: base64.b64encode(content).decode() for name, content in files.items()}
        owner = self
        calls = 0
        def factory(**options):
            nonlocal calls
            calls += 1
            run = calls
            root = Path(options['workspace'])
            writer = next(tool for tool in options['tools'] if isinstance(tool, WriteFileTool))
            reader = next(tool for tool in options['tools'] if isinstance(tool, ReadFileTool))
            async def stream(_):
                relative = 'skills/budget/SKILL.md'
                current = await reader.invoke({'file_path': str(root / 'candidate' / relative)})
                owner.assertTrue(current.success)
                if run == 1:
                    result = await writer.invoke({'file_path': relative, 'content': files[relative].decode() + '\nDraft change'})
                    owner.assertTrue(result.success, str(result))
                    raise RuntimeError('simulated interruption')
                text = (root / 'candidate' / relative).read_text(encoding='utf-8')
                owner.assertEqual('Draft change' in text, run == 2)
                yield {'type': 'answer', 'payload': {'output': json.dumps({'status': 'PRODUCED', 'delivery': {'summary': 'Reviewed draft', 'services': []}})}}
            return SimpleNamespace(stream=stream)
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text('{}', encoding='utf-8')
            def body(attempt, goal='same', prior=None):
                return {'runId': attempt, 'assetDigest': files_digest(files), 'files': encoded,
                        'correlation': {'taskId': 'bundle-1234', 'attemptId': attempt},
                        'model': {'modelId': 'fixture'}, 'bundle': {'mode': 'CHAT', 'source': {'files': encoded},
                        'goal': goal, 'resumeDraftAttemptIds': prior or []}}
            with patch.dict(os.environ, {'FINANCE_RUNTIME_CONFIG': str(config), 'FINANCE_EVAL_DATA_DIR': directory}), \
                    patch('model_config.resolve_model', return_value={'apiKey': 'fixture', 'baseUrl': 'http://localhost/unused', 'supportsTools':True}), \
                    patch('model_config.request_settings', return_value={'model_name': 'fixture'}), \
                    patch('model_config.bind_agent_request_extensions', side_effect=lambda model, *_: model), \
                    patch('openjiuwen.core.foundation.llm.init_model', return_value=object()), \
                    patch('openjiuwen.harness.factory.create_deep_agent', side_effect=factory):
                for attempt, goal, prior, status in [('attempt-1234', 'same', [], 'FAILED'),
                    ('attempt-2345', 'same', ['attempt-1234'], 'PRODUCED'),
                    ('attempt-3456', 'changed', ['attempt-1234'], 'PRODUCED')]:
                    protocol = io.StringIO()
                    await run_bundle(body(attempt, goal, prior), protocol)
                    records = [json.loads(line) for line in protocol.getvalue().splitlines()]
                    result = next(record['result'] for record in records if 'result' in record)
                    self.assertEqual(result['status'], status, result)
                    self.assertEqual(any('已恢复' in record.get('activity', {}).get('label', '') for record in records), attempt == 'attempt-2345')

    def test_draft_integrity_rejects_changed_content(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = MigrationCheckpoint(directory, 'bundle-1234', 'attempt-1234', 'input-hash')
            checkpoint.save({'SKILL.md': 'Zm9v'})
            path = Path(directory) / 'migration-agent-drafts' / 'bundle-1234' / 'attempt-1234.json'
            data = json.loads(path.read_text(encoding='utf-8'))
            data['git']['snapshot']['digest'] = '0' * 64
            path.write_text(json.dumps(data), encoding='utf-8')
            self.assertIsNone(checkpoint.load('attempt-1234'))

    def test_oversized_checkpoint_does_not_overwrite_previous_draft(self):
        with tempfile.TemporaryDirectory() as directory:
            checkpoint = MigrationCheckpoint(directory, 'bundle-1234', 'attempt-1234', 'input-hash')
            checkpoint.save({'SKILL.md': 'Zm9v'})
            with patch('integrations.openjiuwen.migration_checkpoint._MAX_DRAFT_BYTES', 1):
                with self.assertRaises(ValueError):
                    checkpoint.save({'SKILL.md': 'YmFy'})
            self.assertEqual(checkpoint.load('attempt-1234'), {'SKILL.md': 'Zm9v'})

    async def check_combined_file_tools(self, adjustment, mode='CHAT'):
        # Only model execution is substituted; workspace and SDK tools are real.
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        self.addCleanup(sys.path.pop, 0)
        from openjiuwen.harness.tools import WriteFileTool, ReadFileTool
        files, request = fixture()
        files['shared/probe.txt'] = b'temporary'
        if adjustment:
            files['shared/tool.py'] = b'def lookup(): return 0\n'
        encoded = {name: base64.b64encode(content).decode() for name, content in files.items()}
        owner = self
        observations = []

        def agent_factory(**options):
            root = Path(options['workspace'])
            owner.assertFalse(any(tool.card.name in {'submit_result', 'record_result', 'correct_result'} for tool in options['tools']))
            owner.assertFalse(any(tool.card.name == 'run_contract_test' for tool in options['tools']))
            writer = next(tool for tool in options['tools'] if isinstance(tool, WriteFileTool))
            reader = next(tool for tool in options['tools'] if isinstance(tool, ReadFileTool))
            delete = next(tool for tool in options['tools'] if tool.card.name == 'delete_file')
            run_project = next(tool for tool in options['tools'] if tool.card.name == 'run_project_command')

            class Agent:
                async def stream(self, _):
                    owner.assertFalse((await delete.invoke({'file_path': str(root / 'source/shared/probe.txt')}))['accepted'])
                    owner.assertFalse((await delete.invoke({'file_path': 'shared'}))['accepted'])
                    owner.assertTrue((await delete.invoke({'file_path': 'shared/probe.txt'}))['deleted'])
                    owner.assertTrue((root / 'source/shared/probe.txt').exists())
                    paths = ['skills/budget/SKILL.md', 'skills/rules/SKILL.md']
                    if adjustment:
                        paths.append('shared/tool.py')
                    for relative in paths:
                        before = await reader.invoke({'file_path': str(root / 'source' / relative)})
                        observations.append(str(before))
                        owner.assertTrue(before.success)
                        denied = await writer.invoke({'file_path': str(root / 'source' / relative), 'content': 'forbidden'})
                        owner.assertFalse(denied.success)
                        await reader.invoke({'file_path': str(root / 'candidate' / relative)})
                        result = await writer.invoke({'file_path': str(root / 'candidate' / relative), 'content': files[relative].decode() + '\nRepaired'})
                        observations.append(str(result))
                        owner.assertTrue(result.success, str(result))
                        owner.assertEqual((root / 'source' / relative).read_bytes(), files[relative])
                    from project_execution import snapshot_digest
                    receipt = {'command': ['python', '-m', 'unittest'], 'cwd': '.', 'status': 'COMPLETED',
                               'exitCode': 0, 'output': 'tests passed', 'snapshotDigest': snapshot_digest(root / 'candidate')}
                    with patch('project_execution.execute_project_command', new=AsyncMock(return_value=receipt)):
                        actual = await run_project.invoke({'command': receipt['command']})
                    owner.assertEqual(actual, receipt)
                    yield {'type': 'answer', 'payload': {'output': json.dumps({'status': 'PRODUCED', 'delivery': {'summary': 'Two members repaired', 'services': []}})}}
            return Agent()

        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / 'config.json'
            config.write_text('{}', encoding='utf-8')
            protocol = io.StringIO()
            body = {'runId': 'fixture', 'assetDigest': files_digest(files), 'files': encoded,
                    'model': {'modelId': 'fixture'}, 'bundle': {'mode': mode, 'source': {'files': encoded}}}
            if adjustment:
                body['bundle']['adjustmentCapabilities'] = ['document', 'tool', 'runtime']
            with patch.dict(os.environ, {'FINANCE_RUNTIME_CONFIG': str(config)}), \
                    patch('model_config.resolve_model', return_value={'apiKey': 'fixture', 'baseUrl': 'http://localhost/unused', 'supportsTools':True}), \
                    patch('model_config.request_settings', return_value={'model_name': 'fixture'}), \
                    patch('model_config.bind_agent_request_extensions', side_effect=lambda model, *_: model), \
                    patch('openjiuwen.core.foundation.llm.init_model', return_value=object()), \
                    patch('openjiuwen.harness.factory.create_deep_agent', side_effect=agent_factory) as factory:
                await run_bundle(body, protocol)
                factory.assert_called_once()
            result = json.loads(protocol.getvalue())['result']
            self.assertEqual(result['status'], 'PRODUCED', [result, observations])
            self.assertEqual(result['payload']['executions'][0]['output'], 'tests passed')
            self.assertEqual(set(result['files']), set(files) - {'shared/probe.txt'})
            for name in ['budget', 'rules']:
                self.assertTrue(base64.b64decode(result['files']['skills/' + name + '/SKILL.md']).endswith(b'Repaired'))
            self.assertEqual(base64.b64decode(result['files']['shared/data.bin']), files['shared/data.bin'])
            self.assertEqual(result['composition']['role'], 'migration')
            if adjustment:
                self.assertTrue(base64.b64decode(result['files']['shared/tool.py']).endswith(b'Repaired'))


if __name__ == '__main__':
    unittest.main()
