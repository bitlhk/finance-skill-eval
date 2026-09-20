"""Real model -> HTTP Worker -> DeepAgent -> Skill/script/plugin/authenticated MCP."""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import socket
import re
import sys
import tempfile
import time

import httpx

ROOT = Path(__file__).resolve().parents[1]
PYTHON = ROOT / '.venv-openjiuwen/Scripts/python.exe'


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


async def main():
    original = json.loads((ROOT / '.runtime.local.json').read_text(encoding='utf-8'))
    model_id, model = next((key, value) for key, value in original['models'].items() if value.get('enabled') is not False)
    report_dir = ROOT / 'reports' / ('deep-runtime-e2e-' + time.strftime('%Y%m%d-%H%M%S'))
    report_dir.mkdir(parents=True)
    secrets = [value.get('apiKey', '') for value in original['models'].values()] + ['deep-e2e-credential']

    def save(name, data):
        content = json.dumps(data, ensure_ascii=False, indent=2, default=str)
        for secret in secrets:
            if secret:
                content = content.replace(secret, '[redacted]')
        (report_dir / name).write_text(content, encoding='utf-8')

    with tempfile.TemporaryDirectory(prefix='deep-e2e-') as directory:
        work = Path(directory)
        mcp_port, worker_port = free_port(), free_port()
        audit = work / 'mcp-audit.jsonl'
        server = work / 'mcp_server.py'
        server.write_text('''import json, os
from pathlib import Path
from fastmcp import FastMCP
from fastmcp.server.dependencies import get_http_headers
mcp = FastMCP('deep-e2e')
@mcp.tool
def get_balance(account_id: str) -> dict:
    headers = get_http_headers()
    user = json.loads(headers.get('x-business-user', '{}'))
    accepted = headers.get('authorization') == 'Bearer deep-e2e-credential' and user == {'id':'demo-user','tenantId':'demo-tenant'}
    with Path(os.environ['PROBE_AUDIT']).open('a',encoding='utf-8') as output:
        output.write(json.dumps({'account_id':account_id,'auth_ok':accepted,'business_arguments_only':True})+'\\n')
    if not accepted: raise ValueError('Business authentication failed')
    if account_id != 'A1': raise ValueError('Unknown account')
    return {'account_id':account_id,'balance':1200,'currency':'CNY'}
mcp.run(transport='streamable-http',host='127.0.0.1',port=int(os.environ['PORT']))
''', encoding='utf-8')
        files = {
            'references/rules.md':'服务费率为 2.5%，必须调用脚本计算。',
            'scripts/fee.py':'''import argparse,json
parser=argparse.ArgumentParser();parser.add_argument('--amount',type=float,required=True)
args=parser.parse_args();print(json.dumps({'fee':args.amount*0.025}))
''',
            'plugins/workspace/manifest.json':json.dumps({'packageType':'plugin','id':'workspace-probe','tools':[{'file':'tool.py','class':'WorkspaceProbe'}]}),
            'plugins/workspace/tool.py':'''from openjiuwen.core.foundation.tool import Tool, ToolCard
from openjiuwen.core.sys_operation.cwd import get_cwd
class WorkspaceProbe(Tool):
    def __init__(self):
        super().__init__(ToolCard(id='workspace-info',name='workspace_info',description='Return the active Runtime workspace and a verification marker.',input_params={'type':'object','properties':{}}))
    async def invoke(self, inputs, **kwargs):
        return {'workspace':str(get_cwd()),'marker':'HARNESS_LOADED'}
    async def stream(self, inputs, **kwargs):
        yield await self.invoke(inputs, **kwargs)
''',
        }
        instructions = '''---
name: deep-runtime-e2e
description: 企业余额、服务费与运行环境验证
---
必须依次完成：
1. 用 skill_tool 加载 references/rules.md。
2. 调用 get_balance，account_id 为 A1。
3. 用 bash 执行脚本索引的 fee.py，命令行参数 --amount 100。
4. 调用 workspace_info。
最后输出 JSON：balance 为余额，fee 为脚本结果，marker 为 workspace_info 返回的 marker。不要猜测这些值。
'''
        digest = hashlib.sha256(json.dumps({'instructions':instructions,'files':files},sort_keys=True).encode()).hexdigest()
        mcp_endpoint = f'http://127.0.0.1:{mcp_port}/mcp'
        runtime_config = {'models':{model_id:model},'mcp':{mcp_endpoint:{'toolNames':['get_balance'],'dataMode':'authenticated-e2e'}}}
        config_path = work / 'config.json'
        config_path.write_text(json.dumps(runtime_config),encoding='utf-8')
        base = f'http://127.0.0.1:{worker_port}'
        processes, log_files = [], []
        try:
            for name, arguments, env in [
                ('mcp',[str(PYTHON),'-B',str(server)],{'PORT':str(mcp_port),'PROBE_AUDIT':str(audit)}),
                ('worker',[str(PYTHON),'-B','-m','uvicorn','integrations.openjiuwen.worker:app','--app-dir',str(ROOT),'--host','127.0.0.1','--port',str(worker_port)],{'FINANCE_RUNTIME_CONFIG':str(config_path),'DEEP_E2E_TOKEN':'deep-e2e-credential'}),
            ]:
                log = (work / (name+'.log')).open('wb');log_files.append(log)
                processes.append(await asyncio.create_subprocess_exec(*arguments,cwd=str(work),env={**os.environ,**env,'PYTHONDONTWRITEBYTECODE':'1','PYTHONUTF8':'1','NO_PROXY':'127.0.0.1,localhost'},stdout=log,stderr=log))
            async with httpx.AsyncClient(timeout=310,trust_env=False) as client:
                deadline = time.monotonic()+100
                while True:
                    if any(process.returncode is not None for process in processes):
                        raise RuntimeError('A verification service exited during startup')
                    try:
                        response=await client.get(base+'/health',timeout=3)
                        if response.status_code==200:break
                    except httpx.HTTPError:pass
                    if time.monotonic()>deadline:raise TimeoutError('Worker startup timed out')
                    await asyncio.sleep(0.5)
                save('health.json',response.json())
                evidence = []
                answers = []
                for side in ['left','right']:
                    body = {'schemaVersion':'finance.skill-eval.runtime-request.v1','runId':'deep-e2e','side':side,
                        'model':{'modelId':model_id,'providerId':model.get('providerId','service-execution')},
                        'variant':{'mode':'skill_version','skillId':'deep-runtime-e2e','version':'1','artifactSha256':digest},
                        'skill':{'skillId':'deep-runtime-e2e','version':'1','artifactSha256':digest,'instructions':instructions,'files':files},
                        'case':{'caseId':'DEEP-E2E','prompt':'按 Skill 完成 A1 余额查询、金额 100 的服务费计算以及运行环境核验。必须使用所有指定工具，最后给出 JSON 结果。','requiredTools':['get_balance','fee_script','workspace_info']},
                        'environment':{'environmentId':'deep-e2e','mcpServers':[{'endpoint':mcp_endpoint,'toolNames':['get_balance']}],
                            'commandScripts':[{'name':'fee_script','path':'scripts/fee.py','kind':'PYTHON','launch':{'program':'python','args':['scripts/fee.py','--amount','100']}}],
                            'candidateHarnessPlugins':[{'assetDigest':digest,'manifestPath':'plugins/workspace/manifest.json','filePaths':['plugins/workspace/manifest.json','plugins/workspace/tool.py'],'toolNames':['workspace_info']}],
                            'runtimeToolConfig':{'context':{'user':{'type':'object','value':{'id':'demo-user','tenantId':'demo-tenant'},'sensitive':False},'token':{'type':'string','env':'DEEP_E2E_TOKEN'}},
                                'providers':{'business':{'implementation':'bearer','inputs':{'token':'context.token'}}},
                                'tools':{'get_balance':{'contextBindings':{'X-Business-User':'context.user'},'authProvider':'business'}}}}}
                    print('LIVE '+side.upper()+' START',flush=True)
                    frames=[]
                    async with client.stream('POST',base+'/execute',json=body) as response:
                        response.raise_for_status()
                        async for line in response.aiter_lines():
                            if line.startswith('data:'):frames.append(json.loads(line[5:]))
                    save(side+'-stream.json',frames)
                    observed=next((frame['evidence'] for frame in reversed(frames) if 'evidence' in frame),None)
                    assert observed and observed['status']=='completed',observed
                    assert observed['metadata']['agentType']=='DeepAgent'
                    assert observed['metadata']['skillArtifactSha256']==digest
                    used={tool['name'] for tool in observed['toolCalls'] if tool['status']=='completed'}
                    assert {'skill_tool','get_balance','bash','workspace_info'}<=used,used
                    assert not {'read_file','command'}&used
                    assert 'references/rules.md' in observed['metadata']['referenceFilesRead']
                    assert all(value in observed['output'] for value in ('1200','2.5','HARNESS_LOADED')),observed['output']
                    json_answers = re.findall(r'```(?:json)?\s*(\{[^`]*\})\s*```', observed['output'])
                    answer = json.loads(json_answers[-1] if json_answers else observed['output'].strip())
                    assert answer == {'balance':1200,'fee':2.5,'marker':'HARNESS_LOADED'},answer
                    answers.append(answer)
                    assert 'deep-e2e-credential' not in json.dumps(frames)
                    starts=[frame['toolName'] for frame in frames if frame.get('type')=='tool_start']
                    assert {'skill_tool','get_balance','bash','workspace_info'}<=set(starts),starts
                    evidence.append(observed)
                    print('LIVE '+side.upper()+' PASSED',flush=True)
                calls=[json.loads(line) for line in audit.read_text().splitlines()]
                assert len(calls)>=2 and all(call['auth_ok'] for call in calls),calls
                assert evidence[0]['metadata']['workspacePath']!=evidence[1]['metadata']['workspacePath']
                assert answers[0] == answers[1]
                # The supervisor rejects tampered artifact bindings before starting an Agent.
                body['environment']['candidateHarnessPlugins'][0]['assetDigest']='b'*64
                bad=await client.post(base+'/execute',json=body)
                assert bad.status_code==400
                save('result.json',{'status':'PASSED','realModel':model_id,'upstreamModel':model.get('upstreamModelId',model_id),'sides':2,'mcpCalls':calls,
                    'checks':['DeepAgent HTTP execution','Skill body/reference','authenticated MCP with business-only arguments','native bash script','artifact-bound Harness plugin','streaming tool evidence','separate workspaces','credential redaction','tampered digest rejected'],
                    'scope':'Runtime HTTP E2E; does not run migration Agent or model Judge'})
                print('E2E PASSED '+str(report_dir),flush=True)
        except Exception as exc:
            save('result.json',{'status':'FAILED','error':str(exc)})
            print('E2E FAILED '+str(report_dir),flush=True)
            raise
        finally:
            for process in processes:
                if process.returncode is None:
                    if os.name == 'nt':
                        cleanup=await asyncio.create_subprocess_exec('taskkill','/PID',str(process.pid),'/T','/F',stdout=asyncio.subprocess.DEVNULL,stderr=asyncio.subprocess.DEVNULL)
                        await cleanup.wait()
                    else:
                        process.terminate()
                    await process.wait()
            for log in log_files:log.close()


if __name__=='__main__':asyncio.run(main())
