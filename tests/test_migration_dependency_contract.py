"""Generation may check contracts without running credential-dependent business code."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from integrations.openjiuwen.migration_tools import _compile_source, _contract_suite, _contract_test, _script_contract


class RuntimeDependencyContractTests(unittest.IsolatedAsyncioTestCase):
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
