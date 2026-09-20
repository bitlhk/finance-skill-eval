"""Pinned framework tests for artifact-bound DeepAgent Harness plugins."""
import json
import sys
import tempfile
import unittest
from contextlib import AsyncExitStack
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations/openjiuwen'))
from skill_runtime import mount_skill_runtime
from openjiuwen.harness.deep_agent import DeepAgent
from openjiuwen.harness.schema.config import DeepAgentConfig
from openjiuwen.core.single_agent.schema.agent_card import AgentCard
from openjiuwen.core.single_agent.rail.base import AgentCallbackContext
from openjiuwen.core.foundation.llm import ToolCall
from openjiuwen.core.session.agent import Session

SOURCE = '''from openjiuwen.core.foundation.tool import Tool, ToolCard
class ProbeTool(Tool):
    def __init__(self):
        super().__init__(ToolCard(id="probe",name="probe",description="probe",input_params={"type":"object","properties":{}}))
    async def invoke(self, inputs, **kwargs):
        return {"answer":42,"session":kwargs.get("session") is not None}
    async def stream(self, inputs, **kwargs):
        yield await self.invoke(inputs, **kwargs)
'''


class DeepRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def mount(self, stack, *, digest='a'*64, names=None, manifest=None):
        root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        work = Path(stack.enter_context(tempfile.TemporaryDirectory()))
        agent = DeepAgent(AgentCard(id='deep-test', name='test'))
        agent.configure(DeepAgentConfig(system_prompt='test', auto_create_workspace=False, enable_tool_resilience_rail=False))
        files = {'plugins/demo/manifest.json': json.dumps(manifest or {'packageType':'plugin','id':'demo','tools':[{'file':'tool.py','class':'ProbeTool'}]}),
                 'plugins/demo/tool.py': SOURCE}
        skill = {'instructions':'---\nname: demo\ndescription: test\n---\nBODY', 'files':files, 'artifactSha256':'a'*64}
        binding = {'assetDigest':digest, 'manifestPath':'plugins/demo/manifest.json', 'filePaths':list(files), 'toolNames':names or ['probe']}
        observed, starts = [], []
        found = await mount_skill_runtime(agent, stack, skill, root, work, [], lambda *args:observed.append(args),
            plugins=[binding], artifact_digest='a'*64, observe_start=starts.append)
        return agent, found, observed, starts

    async def test_plugin_executes_through_inner_agent_and_records_evidence(self):
        async with AsyncExitStack() as stack:
            agent, found, observed, starts = await self.mount(stack)
            await agent.ensure_initialized()
            self.assertEqual(found, {'probe'})
            self.assertIs(agent.ability_manager, agent.react_agent.ability_manager)
            session = Session(session_id='deep-test-session', card=agent.card)
            results = await agent.ability_manager.execute(ctx=AgentCallbackContext(agent=agent.react_agent,session=session),
                tool_call=ToolCall(id='call',type='function',name='probe',arguments='{}'),session=session)
            self.assertEqual(results[0][0], {'answer':42,'session':True})
            self.assertEqual(starts, ['probe'])
            self.assertEqual(observed[0][0], 'probe')
            self.assertEqual(observed[0][1], {})
            for name in ('command','read_file','bash','list_skill'):
                self.assertIsNone(agent.ability_manager.get(name))

    async def test_wrong_digest_is_rejected(self):
        async with AsyncExitStack() as stack:
            with self.assertRaisesRegex(ValueError, 'digest'):
                await self.mount(stack, digest='b'*64)

    async def test_wrong_tool_names_are_rejected(self):
        async with AsyncExitStack() as stack:
            with self.assertRaisesRegex(ValueError, 'declared names'):
                await self.mount(stack, names=['other'])

    async def test_harness_plugin_cannot_introduce_undeclared_services(self):
        async with AsyncExitStack() as stack:
            with self.assertRaisesRegex(ValueError, 'undeclared'):
                await self.mount(stack, manifest={'packageType':'plugin','id':'demo','mcps':[{'type':'streamable-http','url':'http://localhost/mcp'}]})


if __name__ == '__main__': unittest.main()
