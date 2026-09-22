"""Exercise production session wiring with a deterministic Agent and MCP client."""
import io
import json
import os
import re
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import patch


class SessionBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def execute_session(self, script=False, configured=False, optional_tools=False):
        calls, registered = [], {}
        def module(name, **attributes):
            value = types.ModuleType(name)
            value.__dict__.update(attributes)
            return value
        class Card:
            def __init__(self, **kwargs): self.__dict__.update(kwargs)
        class Function:
            def __init__(self, card, function): self.card, self.function = card, function; registered[card.name] = self
        class Settings(Card):
            def configure_model_client(self, *args, **kwargs): pass
        class Agent:
            def __init__(self, card):
                self.ability_manager = types.SimpleNamespace(add=lambda card: None)
            def configure(self, settings): self.prompt = settings.system_prompt; self.react_agent = self
            async def stream(self, request):
                if script:
                    index = json.loads(re.search(r'可执行脚本索引：([^\n]+)', self.prompt).group(1))
                    self_result = None
                    result = await registered['bash'].function(argv=[sys.executable, index[0]['path']], stdin='account-1')
                    self_test = json.loads(result['stdout'])
                    workspace = re.search(r'当前执行工作区绝对路径：([^\n]+)', self.prompt).group(1)
                    if self_test['cwd'] != workspace or self_test['input'] != 'account-1' or self_test['resource'] != 'package-resource':
                        raise AssertionError(self_test)
                    self_result = self_test['input']
                else:
                    result = await registered['balance'].function(account_id='account-1')
                    self_result = result['balance']
                yield {'type':'llm_output','payload':{'content':str(self_result)}}
            async def clear_session(self, session_id): pass
        class Transport:
            def __init__(self, endpoint, headers): self.headers = headers
        class Client:
            def __init__(self, transport, timeout): self.transport = transport
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def list_tools(self):
                return [types.SimpleNamespace(name='balance', description='balance', inputSchema={'type':'object','properties':{'account_id':{'type':'string'}},'required':['account_id']})]
            async def call_tool(self, name, arguments):
                calls.append({'headers':self.transport.headers, 'arguments':arguments})
                return types.SimpleNamespace(is_error=False, structured_content={'balance':100})
        modules = {
            'fastmcp':module('fastmcp', Client=Client),
            'fastmcp.client.transports':module('fastmcp.client.transports', StreamableHttpTransport=Transport),
            'openjiuwen.harness.deep_agent':module('deep_agent', DeepAgent=Agent),
            'openjiuwen.harness.schema.config':module('config', DeepAgentConfig=Settings),
            'openjiuwen.core.single_agent.schema.agent_card':module('agent_card', AgentCard=Card),
            'openjiuwen.core.foundation.tool':module('tool', ToolCard=Card, LocalFunction=Function),
            'openjiuwen.core.runner':module('runner', Runner=types.SimpleNamespace(resource_mgr=types.SimpleNamespace(add_tool=lambda tool, refresh=False: None))),
            'openjiuwen.core.foundation.llm':module('llm', Model=lambda *args:Card()),
            'openjiuwen.core.foundation.llm.schema.config':module('config', ModelRequestConfig=Card, ModelClientConfig=Card),
        }
        directory = str(Path('integrations/openjiuwen').resolve())
        with patch.object(sys, 'path', [directory, *sys.path]), patch.dict(sys.modules, modules):
            saved_stdout = sys.stdout
            try:
                import session
            finally:
                sys.stdout = saved_stdout
            with tempfile.TemporaryDirectory() as root:
                config = Path(root, 'config.json')
                config.write_text(json.dumps({'mcp':{'http://local/mcp':{'toolNames':['balance']}}}), encoding='utf-8')
                environment = {'commandScripts':[{'name':'balance_script','path':'scripts/balance.py','kind':'PYTHON'}]} if script else {
                    'mcpServers':[{'endpoint':'http://local/mcp','toolNames':['balance']}],
                    'runtimeToolConfig':{'context':{'user':{'type':'object','value':{'id':'u1','tenantId':'t1'}},'token':{'type':'string','value':'secret-token'}},
                        'providers':{'business':{'implementation':'bearer','inputs':{'token':'context.token'}}},
                        'tools':{'balance':{'contextBindings':{'X-Business-User':'context.user'},'authProvider':'business'}}}}
                script_source = 'import sys, json\nfrom pathlib import Path\nvalue=sys.stdin.read()\nPath("report.txt").write_text(value)\nprint(json.dumps({"input":value,"cwd":str(Path.cwd()),"resource":Path(__file__).with_name("resource.txt").read_text()}))\n'
                body = {'runId':'r1','side':'right','model':{'modelId':'test','providerId':'test'},'variant':{'mode':'skill_version','skillId':'test','version':'1','artifactSha256':'a'*64},
                    'case':{'caseId':'c1','prompt':'query','requiredTools':['balance_script' if script else 'balance']},'environment':environment,
                    'skill':{'skillId':'test','version':'1','artifactSha256':'a'*64,'instructions':'Run scripts/balance.py using command','files':{'scripts/balance.py':script_source,'scripts/resource.txt':'package-resource'}}}
                if configured:
                    external_skill = Path(root, 'installed-skill')
                    for name, content in body['skill']['files'].items():
                        target = external_skill / name
                        target.parent.mkdir(parents=True, exist_ok=True)
                        target.write_text(content, encoding='utf-8')
                    config.write_text(json.dumps({'workspaceDirectory':str(Path(root,'work')), 'skillDirectories':{'a'*64:str(external_skill)}}), encoding='utf-8')
                if optional_tools:
                    body['case']['requiredTools'] = []
                    body['environment']['availableToolNames'] = ['balance']
                output = io.StringIO()
                async def mount(agent, stack, skill, root_path, workspace_path, requested, observe=None, **kwargs):
                    self.assertNotIn('SKILL_BODY_ONLY', agent.prompt)
                    if skill:
                        registered['skill_tool'] = Function(Card(name='skill_tool'), None)
                    if 'bash' in requested:
                        from command_runtime import execute_command, command_environment
                        async def execute(argv, stdin=''):
                            return await execute_command(workspace_path, argv, stdin, command_environment())
                        registered['bash'] = Function(Card(name='bash'), execute)
                    return set(requested)
                runtime_environment = {'FINANCE_RUNTIME_CONFIG':str(config), **({'FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS':'1'} if script else {})}
                with patch.dict(os.environ, runtime_environment), patch.object(session,'protocol',output), patch.object(session,'mount_skill_runtime',side_effect=mount), patch.object(session,'resolve_model',return_value={'apiKey':'model-key','baseUrl':'http://model'}), patch.object(session,'request_settings',return_value={'model_name':'test'}):
                    await session.run(body)
                evidence = json.loads(output.getvalue().splitlines()[-1])['evidence']
                self.assertEqual(evidence['status'], 'completed', evidence['error'])
                workspace = Path(evidence['metadata']['workspacePath'])
                skill_path = Path(evidence['metadata']['skillPath'])
                self.assertNotEqual(workspace, skill_path)
                if configured:
                    self.assertEqual(workspace.joinpath('report.txt').read_text(), 'account-1')
                    self.assertTrue(skill_path.joinpath('scripts/balance.py').is_file())
                else:
                    self.assertFalse(workspace.exists())
                    self.assertFalse(skill_path.exists())
                return registered, calls, evidence

    async def test_script_requests_shell_without_registering_command_or_read_file(self):
        registered, calls, evidence = await self.execute_session(script=True)
        self.assertEqual(set(registered), {'bash','skill_tool'})
        self.assertEqual(evidence['output'], 'account-1')

    async def test_mcp_headers_receive_context_and_arguments_only_receive_business_input(self):
        registered, calls, evidence = await self.execute_session()
        self.assertEqual(set(registered), {'balance', 'skill_tool'})
        self.assertEqual(calls[0]['arguments'], {'account_id':'account-1'})
        self.assertEqual(json.loads(calls[0]['headers']['X-Business-User']), {'id':'u1','tenantId':'t1'})
        self.assertEqual(calls[0]['headers']['Authorization'], 'Bearer secret-token')
        self.assertEqual(registered['balance'].card.input_params['required'], ['account_id'])
        self.assertNotIn('secret-token', json.dumps(evidence))

    async def test_configured_workspace_and_external_skill_are_preserved(self):
        await self.execute_session(script=True, configured=True)

    async def test_natural_language_task_can_use_available_tools_without_required_calls(self):
        registered, calls, evidence = await self.execute_session(optional_tools=True)
        self.assertIn('balance', registered)
        self.assertEqual(calls[0]['arguments'], {'account_id':'account-1'})
        self.assertEqual(evidence['status'], 'completed')


if __name__ == '__main__': unittest.main()
