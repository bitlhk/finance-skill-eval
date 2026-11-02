import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from integrations.openjiuwen.bundle_agent import bundle_contract_registry
from integrations.openjiuwen.migration_tools import _contract_test, _declared_shape_ok, _script_contract


class EnterpriseToolContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_isolated_python_keeps_unicode_input_and_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / 'tool.py'
            script.write_text('import json,sys\nvalue=json.load(sys.stdin)\nprint(json.dumps({"card":value["title"],"encoding":sys.stdout.encoding},ensure_ascii=False))', encoding='utf-8')
            result = await _script_contract(root, {'language': 'python'}, script, {'title': '会议室 🚀'})
            self.assertTrue(result['passed'], result)
            self.assertEqual(result['produced']['card'], '会议室 🚀')
            self.assertEqual(result['produced']['encoding'].lower().replace('-', ''), 'utf8')

    def registry(self):
        return bundle_contract_registry({'diagnosis': {'tools': [{'id': 'card', 'name': 'card', 'language': 'node'}]},
            'standardization': {'tools': [{'toolId': 'card', 'form': 'SCRIPT', 'contract': {
                'inputSchema': {'type': 'object', 'properties': {'title': {'type': 'string'}}, 'required': ['title']},
                'outputSchema': {'anyOf': [{'type': 'object', 'required': ['card'], 'properties': {'card': {'type': 'string'}}}, {'type': 'string'}]},
                'sampleInput': {'tool': 'card', 'arguments': {'title': 'Test'}}, 'sampleReason': 'Local formatter'}}]}})

    def test_dispatch_envelope_preserves_and_checks_business_arguments(self):
        entry = self.registry()['card']
        self.assertTrue(_declared_shape_ok(entry['sampleInput'], entry['inputSchema'])[0])
        self.assertFalse(_declared_shape_ok({'tool': 'other', 'arguments': {'title': 'Test'}}, entry['inputSchema'])[0])
        self.assertFalse(_declared_shape_ok({'tool': 'card', 'arguments': {'title': 5}}, entry['inputSchema'])[0])

    def test_output_union_checks_every_branch_and_nested_types(self):
        schema = self.registry()['card']['outputSchema']
        for value in [{'card': '<card/>'}, '错误：无会议室']:
            self.assertTrue(_declared_shape_ok(value, schema)[0])
        for value in [[], {'card': 7}, {'unrelated': True}]:
            self.assertFalse(_declared_shape_ok(value, schema)[0])
        self.assertFalse(_declared_shape_ok({}, {'$ref': 'https://example.invalid/schema'})[0])

    async def test_environment_dependent_script_waits_without_forcing_mcp_or_running_business(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'tool.mjs').write_text('throw Error("must not execute")')
            registry = self.registry()
            registry['card']['dependencies'] = [{'owner': 'RUNTIME', 'action': 'INJECT', 'name': 'Service URL'}]
            with patch('integrations.openjiuwen.migration_tools._script_contract', new=AsyncMock()) as execute:
                result = await _contract_test(root, registry, 'card', 'tool.mjs')
                execute.assert_not_awaited()
            self.assertTrue(result['passed'])
            self.assertFalse(result['callExecuted'])
            self.assertEqual(result['runtimeDependenciesPending'], ['Service URL'])
            self.assertIn('WAIT_RUNTIME_INPUTS', result['note'])

    async def test_real_script_dispatch_and_output_mismatch_are_distinguished(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            script = root / 'tool.mjs'
            script.write_text("import fs from 'node:fs';const input=JSON.parse(fs.readFileSync(0,'utf8'));console.log(JSON.stringify({card:input.arguments.title}));")
            with patch('integrations.openjiuwen.migration_tools._node_argv', new=AsyncMock(return_value=(['node', 'tool.mjs'], None))):
                good = await _contract_test(root, self.registry(), 'card', 'tool.mjs')
                self.assertTrue(good['passed'], good)
                self.assertTrue(good['callExecuted'])
                script.write_text('console.log(JSON.stringify({card:7}))')
                bad = await _contract_test(root, self.registry(), 'card', 'tool.mjs')
                self.assertFalse(bad['passed'], bad)
                self.assertTrue(bad['callExecuted'])
                self.assertIn('OUTPUT_SHAPE', bad['error'])

    async def test_mcp_uses_the_same_declared_output_gate(self):
        registry = self.registry()
        registry['card']['form'] = 'MCP'
        with tempfile.TemporaryDirectory() as directory, patch(
                'integrations.openjiuwen.migration_tools._mcp_contract',
                new=AsyncMock(return_value={'passed': True, 'produced': {'card': 7}})):
            result = await _contract_test(Path(directory), registry, 'card', '')
        self.assertFalse(result['passed'])
        self.assertTrue(result['callExecuted'])
        self.assertIn('OUTPUT_SHAPE', result['error'])


if __name__ == '__main__':
    unittest.main()
