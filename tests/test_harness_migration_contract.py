"""Actual pinned plugin loader tests used by A4's contract-test tool."""
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'integrations/openjiuwen'))
from migration_tools import _contract_test


class HarnessMigrationContractTests(unittest.IsolatedAsyncioTestCase):
    async def check(self, name='read_document', sample=False):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            plugin=root/'runtime-plugins'/'document'
            (plugin/'implementation').mkdir(parents=True)
            (plugin/'adapter').mkdir()
            (plugin/'implementation'/'original.py').write_text('from pathlib import Path\ndef read_document(path: str) -> str:\n    return Path(path).read_text(encoding="utf-8")\n',encoding='utf-8')
            schema={'type':'object','properties':{'path':{'type':'string'}},'required':['path']}
            (plugin/'adapter'/'tool.py').write_text(f'''from openjiuwen.core.foundation.tool import Tool,ToolCard
from ..implementation.original import read_document
class DocumentTool(Tool):
    def __init__(self):
        super().__init__(ToolCard(id="document",name={name!r},description="read document",input_params={schema!r}))
    async def invoke(self, inputs, **kwargs):
        return read_document(**inputs)
    async def stream(self, inputs, **kwargs):
        yield await self.invoke(inputs, **kwargs)
''',encoding='utf-8')
            manifest='runtime-plugins/document/manifest.json'
            (root/manifest).write_text(json.dumps({'packageType':'plugin','id':'document','tools':[{'file':'adapter/tool.py','class':'DocumentTool'}]}),encoding='utf-8')
            contract={'form':'HARNESS','toolName':'read_document','expectedToolNames':['read_document'],'inputSchema':schema}
            if sample:
                source=root/'document.txt';source.write_text('原始文件内容',encoding='utf-8')
                contract.update(sampleInput={'path':str(source)},sampleOutput='原始文件内容')
            return await _contract_test(root,{'harness:read_document':contract},'harness:read_document',manifest)

    async def test_original_name_and_schema_load_without_invented_call(self):
        result=await self.check()
        self.assertTrue(result['passed'],result)
        self.assertFalse(result['callExecuted'])

    async def test_adapter_delegates_to_original_implementation(self):
        result=await self.check(sample=True)
        self.assertTrue(result['passed'],result)
        self.assertTrue(result['callExecuted'])
        self.assertEqual(result['produced'],'原始文件内容')

    async def test_similar_builtin_name_substitution_is_rejected(self):
        result=await self.check(name='read_file')
        self.assertFalse(result['passed'])
        self.assertEqual(result['error'],'HARNESS_TOOL_NAME_CHANGED')


if __name__=='__main__':unittest.main()
