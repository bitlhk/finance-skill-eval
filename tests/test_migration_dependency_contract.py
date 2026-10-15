"""Generation may check contracts without running credential-dependent business code."""
import base64
from pathlib import Path
import json
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from integrations.openjiuwen.migration_tools import _compile_source, _contract_suite, _contract_test, _script_contract, _mcp_contract, _mcp_contract_suite
from integrations.openjiuwen.agent_protocol import build_workspace, is_output_format_failure, MAX_ITERATION_SENTINEL, declared_delivery_paths, collect_delivery_files


class RuntimeDependencyContractTests(unittest.IsolatedAsyncioTestCase):
    def test_explicitly_reused_modules_remain_in_delivery_without_shipping_all_original_files(self):
        paths=declared_delivery_paths({'tools':[{'entrypoint':'mcp_server.py','files':['mcp_server.py','scripts/check_expense.py','assets/rules.json']}],
            'skillDelivery':{'files':[{'source':'migration-skill/SKILL.md','path':'SKILL.md'}]}})
        self.assertIn('scripts/check_expense.py',paths)
        self.assertIn('assets/rules.json',paths)
        self.assertNotIn('old_agent.py',paths)

    def test_collected_reuse_preserves_bytes_and_excludes_undeclared_originals(self):
        originals={'scripts/helper.py':b'def lookup(): return 1\r\n', 'old_agent.py':b'coupled', 'assets/rules.json':b'{}'}
        payload={'tools':[{'entrypoint':'mcp_server.py','files':['scripts/helper.py','assets/rules.json']}],
                 'skillDelivery':{'files':[{'source':'migration-skill/SKILL.md','path':'SKILL.md'}]}}
        with tempfile.TemporaryDirectory() as directory, patch('integrations.openjiuwen.agent_protocol.tempfile.mkdtemp',return_value=directory):
            root=build_workspace({**originals,'mcp_server.py':b'import helper','migration-skill/SKILL.md':b'new document','AGENT.md':b'scaffold'})
            produced=collect_delivery_files(root,originals,payload)
        self.assertEqual(base64.b64decode(produced['scripts/helper.py']),originals['scripts/helper.py'])
        self.assertEqual(set(produced),{'scripts/helper.py','assets/rules.json','mcp_server.py','migration-skill/SKILL.md'})

    def test_malformed_delivery_collection_is_not_a_crash(self):
        self.assertEqual(declared_delivery_paths({'tools':'invalid','skillDelivery':'invalid'}),set())
        self.assertEqual(declared_delivery_paths({'tools':[{'entrypoint':'main.py','files':'invalid'}]}),{'main.py'})

    def test_generation_workspace_keeps_source_text_bytes_without_crlf_expansion(self):
        original='line1\r\nline2\r\n'
        with tempfile.TemporaryDirectory() as directory, patch('integrations.openjiuwen.agent_protocol.tempfile.mkdtemp',return_value=directory):
            root=build_workspace({'source.txt':original})
            self.assertEqual(root.joinpath('source.txt').read_bytes(),original.encode('utf-8'))

    def test_execution_failure_is_not_a_format_only_repair(self):
        self.assertFalse(is_output_format_failure({'output': MAX_ITERATION_SENTINEL}))
        self.assertFalse(is_output_format_failure({'output': 'connection failed', 'result_type': 'error'}))
        self.assertFalse(is_output_format_failure({'output': ''}))
        self.assertTrue(is_output_format_failure({'output': '{"status":"PRODUCED",'}))

    async def test_mcp_contracts_supply_isolated_workspace_headers_and_preserve_relative_paths(self):
        for suite in [False, True]:
            with self.subTest(suite=suite), tempfile.TemporaryDirectory() as directory:
                root=Path(directory).resolve();root.joinpath('workspace').mkdir()
                root.joinpath('workspace', 'fixture.txt').write_text('fixture')
                root.joinpath('package.txt').write_text('not run data')
                seen=[]
                def post(_url, payload, session_id=None, timeout=30, request_headers=None):
                    execution=Path(request_headers['X-Workspace-Root']);seen.append(execution)
                    self.assertNotEqual(execution,root)
                    self.assertEqual(execution.joinpath('workspace','fixture.txt').read_text(),'fixture')
                    self.assertFalse(execution.joinpath('package.txt').exists())
                    if payload['method']=='tools/list':
                        return 'session',{'result':{'tools':[{'name':'lookup','inputSchema':{'type':'object'}}]}}
                    if payload['method']=='tools/call':
                        return 'session',{'result':{'content':[{'type':'text','text':json.dumps({'value':1})}]}}
                    return 'session',{}
                entry={'toolName':'lookup','start':['fixture-command'],'inputSchema':{'type':'object'}}
                with patch('integrations.openjiuwen.migration_tools.asyncio.create_subprocess_exec',new=AsyncMock()), \
                     patch('integrations.openjiuwen.migration_tools._wait_for_port',new=AsyncMock(return_value=True)), \
                     patch('integrations.openjiuwen.migration_tools._terminate',new=AsyncMock()), \
                     patch('integrations.openjiuwen.migration_tools._mcp_post',side_effect=post):
                    result=await _mcp_contract_suite(root,[{'toolId':'t1','entry':entry,'sample':{},'executeCall':True,'runtimePending':[]}],['fixture-command']) if suite else await _mcp_contract(root,entry,{})
                self.assertTrue(result['passed'],result)
                self.assertEqual(len(set(seen)),1)
                self.assertFalse(seen[0].exists())

    async def test_script_contract_uses_separate_workspace_and_package_resources(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve()
            root.joinpath('resource.txt').write_text('package-resource')
            source=root/'query.mjs'
            source.write_text("import fs from 'node:fs';import path from 'node:path';const resource=fs.readFileSync(new URL('./resource.txt',import.meta.url),'utf8');fs.writeFileSync('report.txt',resource);console.log(JSON.stringify({resource,cwd:process.cwd()}));")
            with patch('integrations.openjiuwen.migration_tools._node_argv',new=AsyncMock(return_value=(['node','query.mjs'],None))):
                result=await _script_contract(root,{'language':'node'},source,{})
            self.assertTrue(result['passed'],result)
            self.assertEqual(result['produced']['resource'],'package-resource')
            self.assertNotEqual(result['produced']['cwd'],str(root))
            self.assertFalse(root.joinpath('report.txt').exists())

    async def test_script_contract_rejects_package_resource_relative_to_cwd(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();root.joinpath('resource.txt').write_text('package-resource')
            source=root/'query.mjs';source.write_text("import fs from 'node:fs';console.log(JSON.stringify(fs.readFileSync('resource.txt','utf8')));")
            with patch('integrations.openjiuwen.migration_tools._node_argv',new=AsyncMock(return_value=(['node','query.mjs'],None))):
                result=await _script_contract(root,{'language':'node'},source,{})
            self.assertFalse(result['passed'])

    async def test_script_accepts_implicit_workspace_and_seeds_fixture_files(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            root.joinpath("workspace").mkdir()
            root.joinpath("workspace", "EXP-001.json").write_text('{"amount": 42}', encoding="utf-8")
            source = root / "lookup.py"
            source.write_text(
                "import json, pathlib, sys\n"
                "request=json.load(sys.stdin)\n"
                "print(json.dumps(json.loads(pathlib.Path(request['claim_id'] + '.json').read_text())))\n",
                encoding="utf-8",
            )
            contract = {
                "tool": {
                    "form": "SCRIPT",
                    "language": "python",
                    "sampleInput": {"claim_id": "EXP-001"},
                    "inputSchema": {"type": "object"},
                    "outputSchema": {"type": "object"},
                    "dependencies": [{
                        "owner": "RUNTIME",
                        "action": "INJECT",
                        "sensitive": False,
                        "name": "workspace",
                        "binding": {"kind": "SCRIPT_CONTEXT", "name": "workspace"},
                    }],
                }
            }
            result = await _contract_test(root, contract, "tool", "lookup.py")
            self.assertTrue(result["passed"], result)
            self.assertTrue(result["callExecuted"])
            self.assertEqual(result["runtimeDependenciesPending"], [])
    def contract(self, form):
        return {"tool": {"form": form, "language": "node", "toolName": "lookup",
                         "sampleInput": {"account_id": "A1"}, "inputSchema": {"type": "object"},
                         "dependencies": [{"owner": "RUNTIME", "action": "INJECT", "blocking": True,
                                           "name": "business credential"}]}}

    async def test_script_is_not_executed_with_invented_credentials(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "lookup.mjs"
            source.write_text("throw Error('business call must not run');", encoding="utf-8")
            result = await _contract_test(root, self.contract("SCRIPT"), "tool", "lookup.mjs")
            self.assertFalse(result["passed"])
            self.assertIn("SCRIPT_RUNTIME_INJECTION_UNSUPPORTED",result["error"])

    async def test_missing_script_entry_still_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            result = await _contract_test(Path(directory), self.contract("SCRIPT"), "tool", "missing.mjs")
            self.assertFalse(result["passed"])
            self.assertIn("ENTRYPOINT_MISSING", result["error"])

    async def test_mcp_checks_service_without_executing_business_call(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch("integrations.openjiuwen.migration_tools._mcp_contract", new=AsyncMock(return_value={"passed": True, "callExecuted": False, "drift": []})) as probe:
                result = await _contract_test(Path(directory), self.contract("MCP"), "tool", "", ["node", "server.mjs"])
                self.assertFalse(probe.call_args.kwargs["execute_call"])
                self.assertTrue(result["passed"])
                self.assertFalse(result["callExecuted"])
                self.assertEqual(result["runtimeDependenciesPending"], ["business credential"])

    async def test_nonblocking_runtime_dependency_still_prevents_a4_business_call(self):
        contract=self.contract("MCP")
        contract["tool"]["dependencies"][0]["blocking"]=False
        with tempfile.TemporaryDirectory() as directory:
            with patch("integrations.openjiuwen.migration_tools._mcp_contract", new=AsyncMock(return_value={"passed": True, "callExecuted": False, "drift": []})) as probe:
                result=await _contract_test(Path(directory),contract,"tool","",["node","server.mjs"])
        self.assertFalse(probe.call_args.kwargs["execute_call"])
        self.assertFalse(result["callExecuted"])
        self.assertEqual(result["runtimeDependenciesPending"],["business credential"])

    async def test_shared_mcp_suite_starts_once_and_keeps_all_injections_pending(self):
        first=self.contract("MCP")["tool"]
        second={**first,"toolName":"check_budget","dependencies":[{"owner":"RUNTIME","action":"INJECT","blocking":False,"name":"department rules"}]}
        contract={"one":first,"two":second}
        observed={"passed":True,"results":[
            {"passed":True,"toolId":"one","callExecuted":False,"runtimeDependenciesPending":["business credential"]},
            {"passed":True,"toolId":"two","callExecuted":False,"runtimeDependenciesPending":["department rules"]},
        ]}
        with tempfile.TemporaryDirectory() as directory:
            with patch("integrations.openjiuwen.migration_tools._mcp_contract_suite",new=AsyncMock(return_value=observed)) as probe:
                result=await _contract_suite(Path(directory),contract,["one","two"],["java","Server"])
        self.assertEqual(probe.await_count,1)
        cases=probe.await_args.args[1]
        self.assertEqual([case["executeCall"] for case in cases],[False,False])
        self.assertEqual(result,observed)

    async def test_java_compile_rejects_build_descriptors_before_running_javac(self):
        with tempfile.TemporaryDirectory() as directory:
            result=await _compile_source(Path(directory),"java",["mcp-java/pom.xml"])
        self.assertFalse(result["passed"])
        self.assertIn("INVALID_SOURCE_PATHS",result["error"])


if __name__ == "__main__":
    unittest.main()
