"""Generation may check contracts without running credential-dependent business code."""
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from integrations.openjiuwen.migration_tools import _contract_test, _script_contract


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


if __name__ == "__main__":
    unittest.main()
