"""Target-Runtime Harness plugin contract verification in an isolated process."""
import asyncio
import json
from pathlib import Path
import sys


async def verify(workspace, entry):
    from openjiuwen.harness.deep_agent import DeepAgent
    from openjiuwen.harness.schema.config import DeepAgentConfig
    from openjiuwen.core.single_agent.schema.agent_card import AgentCard
    from openjiuwen.core.runner import Runner
    from openjiuwen.core.session.agent import Session
    from openjiuwen.core.sys_operation import SysOperation
    from openjiuwen.core.sys_operation.base import OperationMode
    from openjiuwen.core.sys_operation.sys_operation import SysOperationCard
    manifest = (workspace / entry['manifestPath']).resolve()
    if workspace not in manifest.parents or manifest.name != 'manifest.json' or not manifest.is_file():
        return {'passed':False,'error':'HARNESS_MANIFEST_MISSING_OR_UNSAFE'}
    payload = json.loads(manifest.read_text(encoding='utf-8'))
    if payload.get('mcps') or payload.get('skills') or payload.get('rails'):
        return {'passed':False,'error':'HARNESS_UNDECLARED_CAPABILITIES'}
    operation = SysOperation(SysOperationCard(id='harness-contract',mode=OperationMode.LOCAL))
    agent = DeepAgent(AgentCard(id='harness-contract',name='Harness contract verification'))
    agent.configure(DeepAgentConfig(system_prompt='verification',auto_create_workspace=False,
        sys_operation=operation,cwd=str(workspace),enable_task_loop=False,enable_tool_resilience_rail=False))
    await agent.load_plugin(str(manifest))
    names = [card.name for card in agent.ability_manager.list()]
    expected = entry.get('expectedToolNames', [entry['toolName']])
    if entry['toolName'] not in names or any(name not in expected for name in names):
        return {'passed':False,'error':'HARNESS_TOOL_NAME_CHANGED','observedToolNames':names}
    card = agent.ability_manager.get(entry['toolName'])
    tool = Runner.resource_mgr.get_tool(tool_id=card.id)
    if tool is None:
        return {'passed':False,'error':'HARNESS_IMPLEMENTATION_NOT_REGISTERED'}
    baseline = entry.get('inputSchema')
    if baseline is not None and card.input_params != baseline:
        return {'passed':False,'error':'HARNESS_INPUT_SCHEMA_CHANGED','baseline':baseline,'observed':card.input_params}
    outcome = {'passed':True,'contractPassed':True,'callExecuted':False,'observedToolNames':names,
               'inputSchema':card.input_params,'drift':[],'note':'原名插件加载通过；没有源调用样例，不宣称行为或返回值已验证'}
    if 'sampleInput' in entry:
        session = Session(session_id='harness-contract-session',card=agent.card)
        outcome['produced'] = await tool.invoke(entry['sampleInput'],session=session)
        if 'sampleOutput' in entry and outcome['produced'] != entry['sampleOutput']:
            return {'passed':False,'error':'HARNESS_OUTPUT_CHANGED','observed':outcome['produced']}
        outcome['callExecuted'] = True
        outcome['note'] = '源调用样例已实际执行；返回值按已提供的基线检查' if 'sampleOutput' in entry else '源调用样例已实际执行；未提供返回值基线'
    return outcome


if __name__=='__main__':
    try:
        result=asyncio.run(verify(Path.cwd().resolve(),json.loads(sys.argv[1])))
    except Exception as exc:
        result={'passed':False,'error':f'{type(exc).__name__}: {exc}'[:1200]}
    print('HARNESS_CONTRACT_JSON='+json.dumps(result,ensure_ascii=False,default=str))
