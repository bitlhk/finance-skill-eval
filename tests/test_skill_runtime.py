"""Integration checks against the pinned OpenJiuwen, without a model request."""
import sys
import json
import tempfile
import unittest
from types import SimpleNamespace
from contextlib import AsyncExitStack
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'integrations/openjiuwen'))
from skill_runtime import mount_skill_runtime
from openjiuwen.core.single_agent.agents.react_agent import ReActAgent, ReActAgentConfig
from openjiuwen.core.single_agent.schema.agent_card import AgentCard


class SkillRuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def test_skill_tool_loads_body_and_reference_without_default_file_or_shell_tools(self):
        async with AsyncExitStack() as stack:
            root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
            work = Path(stack.enter_context(tempfile.TemporaryDirectory()))
            agent = ReActAgent(AgentCard(id='skill-test', name='test'))
            agent.configure(ReActAgentConfig())
            rails, observed = [], []
            register = agent.register_rail
            async def capture(rail):
                rails.append(rail)
                return await register(rail)
            agent.register_rail = capture
            skill = {'instructions':'---\nname: demo\ndescription: example\n---\nSKILL_BODY',
                     'files':{'references/rules.md':'REFERENCE_BODY'}}
            selected = await mount_skill_runtime(agent, stack, skill, root, work, [], lambda *args:observed.append(args))
            await rails[0].before_model_call(SimpleNamespace(session=None, extra={}))
            self.assertIn('target-skill', agent.prompt_builder.build())
            self.assertNotIn('SKILL_BODY', agent.prompt_builder.build())
            self.assertEqual(selected, set())
            self.assertIsNotNone(agent.ability_manager.get('skill_tool'))
            for name in ['read_file', 'command', 'bash', 'list_skill']:
                self.assertIsNone(agent.ability_manager.get(name), name)
            # Use the framework's actual tool instance through its resource registry.
            from openjiuwen.core.runner import Runner
            tool = Runner.resource_mgr.get_tool(tool_id=agent.ability_manager.get('skill_tool').id)
            result = await tool.invoke({'skill_name':'target-skill'})
            self.assertTrue(result.success, result.error)
            self.assertIn('SKILL_BODY', json.dumps(result.data))
            result = await tool.invoke({'skill_name':'target-skill','relative_file_path':'references/rules.md'})
            self.assertTrue(result.success, result.error)
            self.assertIn('REFERENCE_BODY', json.dumps(result.data))
            await rails[1].after_tool_call(SimpleNamespace(inputs=SimpleNamespace(tool_name='skill_tool',
                tool_args={'skill_name':'target-skill','relative_file_path':'references/rules.md'},tool_result=result)))
            self.assertEqual(observed[0][0], 'skill_tool')
            self.assertFalse((await tool.invoke({'skill_name':'target-skill','relative_file_path':'../outside'})).success)

    async def test_other_harness_tools_are_only_loaded_on_request(self):
        async with AsyncExitStack() as stack:
            root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
            work = Path(stack.enter_context(tempfile.TemporaryDirectory()))
            agent = ReActAgent(AgentCard(id='harness-test', name='test'))
            agent.configure(ReActAgentConfig())
            selected = await mount_skill_runtime(agent, stack, None, root, work, ['glob'])
            self.assertEqual(selected, {'glob'})
            self.assertIsNotNone(agent.ability_manager.get('glob'))
            self.assertIsNone(agent.ability_manager.get('read_file'))
            self.assertIsNone(agent.ability_manager.get('bash'))

    async def test_requested_framework_shell_executes_in_workspace(self):
        async with AsyncExitStack() as stack:
            root = Path(stack.enter_context(tempfile.TemporaryDirectory()))
            work = Path(stack.enter_context(tempfile.TemporaryDirectory()))
            agent = ReActAgent(AgentCard(id='shell-test', name='test'))
            agent.configure(ReActAgentConfig())
            await mount_skill_runtime(agent, stack, None, root, work, ['bash'])
            from openjiuwen.core.runner import Runner
            tool = Runner.resource_mgr.get_tool(tool_id=agent.ability_manager.get('bash').id)
            result = await tool.invoke({'command':'python -c "from pathlib import Path; print(Path.cwd())"'})
            self.assertTrue(result.success, result.error)
            self.assertIn(str(work).replace('\\','\\\\'), json.dumps(result.data))


if __name__ == '__main__':
    unittest.main()
