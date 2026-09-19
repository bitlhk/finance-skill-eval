import { mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach,expect,it,vi } from 'vitest';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { validateSkill } from '../src/service/skill-validator.js';
import { inspectProject } from '../src/service/tool-inspector.js';
import { buildMigrationPlan } from '../src/service/migration-model.js';
import { LocalWorker } from '../src/service/local-worker.js';
import { findMissingRequiredTools } from '../src/service/run-manager.js';
import { createEvaluationService } from '../src/service/server.js';

const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

it('checks the enterprise Skill baseline without treating tool language as compliance',()=>{
  const files={'account-balance/SKILL.md':'---\nname: account-balance\ndescription: 查询余额，用户询问账户资金时使用。\n---\n调用 `get_balance`。失败时不要编造。\n'};
  expect(validateSkill(files,'account-balance/SKILL.md')).toEqual({status:'COMPLIANT',findings:[]});
  const invalid=validateSkill({'bad/SKILL.md':'---\nname: Bad_Name\n---\nUse C:\\private\\tool.py'},'bad/SKILL.md');
  expect(invalid.status).toBe('NON_COMPLIANT');
  expect(invalid.findings.map(f=>f.code)).toEqual(expect.arrayContaining(['NAME_INVALID','DESCRIPTION_REQUIRED','ABSOLUTE_PATH']));
});

it('detects language-neutral MCP, Script and Runtime-bound tools independently',()=>{
  const method='---\nname: mixed-tools\ndescription: 使用三个工具处理测试任务。\n---\n调用 `portable_mcp`、`script_tool` 和 `bound_tool`。失败时返回原因。';
  const files={'SKILL.md':method,
    'server.js':'import { Server } from "@modelcontextprotocol/sdk";\nconst inputSchema={"type":"object"};\nfunction portable_mcp(input) { return input; }\n',
    'scripts/script_tool.py':'import json,sys\ndef script_tool(value): return value\nif __name__ == "__main__": json.dump(script_tool(json.load(sys.stdin)),sys.stdout)\n',
    'bound.py':'from agentscope.tool import ToolResponse\ndef bound_tool(value): return ToolResponse(content=value)\ndef register(toolkit): toolkit.register_tool_function(tool_func=bound_tool)\n'};
  const result=inspectProject({assetId:'a',assetDigest:'d',files,skillFile:'SKILL.md'});
  expect(Object.fromEntries(result.tools.map(t=>[t.name,t.portability]))).toEqual({bound_tool:'RUNTIME_BOUND',portable_mcp:'PORTABLE_MCP',script_tool:'PORTABLE_SCRIPT'});
  expect(result.tools.find(t=>t.name==='portable_mcp')?.language).toBe('JavaScript');
  expect(result.tools.find(t=>t.name==='portable_mcp')?.inputSchema).toEqual({type:'object'});
});

it('does not treat SDK names in comments or ordinary strings as Tool evidence',()=>{
  const result=inspectProject({assetId:'a',assetDigest:'d',skillFile:'SKILL.md',files:{
    'SKILL.md':'---\nname: comment-only\ndescription: 验证注释不会成为依赖证据。\n---\n调用 `plain_tool`，失败时说明原因。',
    'plain.js':'// FastMCP inputSchema agentscope register_tool\nconst note = "McpServer openjiuwen";\nfunction plain_tool(v){ return v; }',
  }});
  expect(result.tools[0]?.portability).toBe('INCOMPLETE');
});

it('allows local Script Tools to satisfy OpenJiuwen required Tool bindings',()=>{
  expect(findMissingRequiredTools(['lookup','calculate'],[],[{name:'lookup',path:'scripts/lookup.py',kind:'PYTHON',filePaths:['scripts/lookup.py']}])).toEqual(['calculate']);
});

it('requires one migration choice per tool and groups MCP choices',()=>{
  const inspection=inspectProject({assetId:'a',assetDigest:'d',skillFile:'SKILL.md',files:{'SKILL.md':'---\nname: mixed\ndescription: 测试工具。\n---\n`mcp_tool` `bound_tool`，失败时说明原因。','mcp.js':'import "@modelcontextprotocol/sdk"; const inputSchema={}; function mcp_tool(){}','bound.py':'from agentscope.tool import ToolResponse\ndef bound_tool(): return ToolResponse(content=[])'}});
  const byName=Object.fromEntries(inspection.tools.map(t=>[t.name,t]));
  const decisions=[{toolId:byName.mcp_tool!.toolId,action:'MIGRATE_TO_MCP' as const,reason:'共享服务',baseAssetId:'a',decidedAt:'now'},
    {toolId:byName.bound_tool!.toolId,action:'MIGRATE_TO_SCRIPT' as const,reason:'本地任务',baseAssetId:'a',decidedAt:'now'}];
  const plan=buildMigrationPlan(inspection,decisions,'a');
  expect(plan.generationAllowed).toBe(true);expect(plan.items.map(i=>i.generator)).toEqual(['PYTHON_SCRIPT','SHARED_JAVA_MCP']);
  expect(buildMigrationPlan(inspection,[decisions[0]!], 'a').generationAllowed).toBe(false);
});

it('runs a trusted one-shot job with JSON IO and always cleans its directory',async()=>{
  vi.stubEnv('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS','1');
  const root=await mkdtemp(path.join(os.tmpdir(),'local-worker-test-'));dirs.push(root);
  const worker=new LocalWorker(root),script='let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({ok:JSON.parse(s).value})));';
  const result=await worker.run({requestId:'test',program:'node',args:['tool.js'],files:[{path:'tool.js',content:Buffer.from(script)}],stdin:'{"value":7}'});
  expect(result.mode).toBe('LOCAL_TRUSTED');expect(result.exitCode).toBe(0);expect(JSON.parse(result.stdout)).toEqual({ok:7});expect(await readdir(root)).toEqual([]);
  const controller=new AbortController(),cancelled=worker.run({requestId:'cancel',program:'node',args:['wait.js'],files:[{path:'wait.js',content:Buffer.from('setInterval(()=>{},1000)')}],signal:controller.signal});
  setTimeout(()=>controller.abort(),30);expect((await cancelled).cancelled).toBe(true);expect(await readdir(root)).toEqual([]);
  await expect(worker.run({requestId:'bad',program:'cmd.exe',args:[],files:[]})).rejects.toThrow('not allowed');
  await expect(worker.run({requestId:'bad-path',program:'node',args:[],files:[{path:'../escape',content:Buffer.from('')}]})).rejects.toThrow('Unsafe');
});

it('exposes the v2 inspection, mixed decisions and immutable generated candidate over HTTP',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-v2-http-'));dirs.push(data);
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false});
  const headers={authorization:'Bearer test'},post=(url:string,payload:unknown)=>(app.inject({method:'POST',url,headers,payload}));
  try{
    const archive={'SKILL.md':'---\nname: mixed-tools\ndescription: 使用多个工具处理测试任务。\n---\n调用 `portable_mcp`、`script_tool` 和 `bound_tool`。失败时返回原因。',
      'server.js':'import { Server } from "@modelcontextprotocol/sdk"; const inputSchema={type:"object"}; function portable_mcp(v){return v}',
      'scripts/script_tool.py':'import json,sys\ndef script_tool(v): return v\nif __name__ == "__main__": json.dump(script_tool(json.load(sys.stdin)),sys.stdout)',
      'bound.py':'from agentscope.tool import ToolResponse\ndef bound_tool(v): return ToolResponse(content=v)\ndef register(t): t.register_tool_function(tool_func=bound_tool)'};
    const zip=Buffer.from(zipSync(Object.fromEntries(Object.entries(archive).map(([name,value])=>[name,strToU8(value)]))));
    const uploaded=(await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:zip})).json();
    const project=(await post('/api/migrations',{sourceAssetId:uploaded.assetId,name:'mixed'})).json();
    expect(project.schemaVersion).toBe('finance.skill-migration.v2');
    const inspection=(await post(`/api/migrations/${project.id}/inspect`,{})).json();
    expect(inspection.tools).toHaveLength(3);expect(inspection.scriptsExecuted).toBe(false);
    for(const tool of inspection.tools){const action=tool.name==='script_tool'?'MIGRATE_TO_SCRIPT':'MIGRATE_TO_MCP';
      expect((await app.inject({method:'PUT',url:`/api/migrations/${project.id}/tools/${tool.toolId}/decision`,headers,payload:{action,baseAssetId:uploaded.assetId}})).statusCode).toBe(200);}
    const plan=(await app.inject({url:`/api/migrations/${project.id}/plan`,headers})).json();expect(plan.generationAllowed).toBe(true);expect(new Set(plan.items.map((i:{generator:string})=>i.generator))).toEqual(new Set(['PYTHON_SCRIPT','SHARED_JAVA_MCP']));
    const generated=await post(`/api/migrations/${project.id}/generate`,{baseAssetId:uploaded.assetId});expect(generated.statusCode).toBe(200);
    const candidate=generated.json().candidate;expect(candidate.assetId).not.toBe(uploaded.assetId);
    const report=(await app.inject({url:`/api/migrations/${project.id}/report`,headers})).json();
    expect(report.portableGenerationDiff.some((item:{path:string})=>item.path.endsWith('MigrationMcpServer.java'))).toBe(true);
    const exported=await app.inject({url:`/api/migrations/${project.id}/export`,headers});expect(exported.statusCode).toBe(200);
    const files=unzipSync(exported.rawPayload),names=Object.keys(files);
    expect(names.filter(name=>name==='migration-generated/v2/mcp-service/pom.xml')).toHaveLength(1);
    expect(Buffer.from(files['migration-generated/v2/mcp-service/src/main/java/com/finance/migration/MigrationMcpServer.java']!).toString()).toContain('portable_mcp');
    expect(Buffer.from(files['migration-generated/v2/mcp-service/src/main/java/com/finance/migration/MigrationMcpServer.java']!).toString()).toContain('bound_tool');
    const scriptTool=inspection.tools.find((t:{name:string})=>t.name==='script_tool');
    const scriptValidation=await post(`/api/migrations/${project.id}/validate/technical`,{toolId:scriptTool.toolId,baseAssetId:candidate.assetId,request:{value:7}});
    expect(scriptValidation.statusCode).toBe(409);
    expect((await post(`/api/migrations/${project.id}/validate/technical`,{toolId:inspection.tools.find((t:{name:string})=>t.name==='bound_tool').toolId,baseAssetId:candidate.assetId})).statusCode).toBe(409);
    expect((await post(`/api/migrations/${project.id}/validate/openjiuwen`,{})).statusCode).toBe(409);
  }finally{await app.close();}
});

it('exports v2 evidence states and upgrades legacy projects without changing history',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-v2-state-'));dirs.push(data);
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false});
  const headers={authorization:'Bearer test'},post=(url:string,payload:unknown={})=>app.inject({method:'POST',url,headers,payload});
  try{
    const zip=Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: text-only\ndescription: 处理不需要工具的文本任务。\n---\n信息不足时明确说明。')}));
    const uploaded=(await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:zip})).json();
    const project=(await post('/api/migrations',{sourceAssetId:uploaded.assetId,name:'text migration'})).json();
    await post(`/api/migrations/${project.id}/inspect`);
    const candidate=(await post(`/api/migrations/${project.id}/generate`,{baseAssetId:uploaded.assetId})).json().candidate;
    const exported=await app.inject({url:`/api/migrations/${project.id}/export`,headers});
    const files=unzipSync(exported.rawPayload),manifest=JSON.parse(Buffer.from(files['migration-manifest.json']!).toString());
    expect(manifest.schemaVersion).toBe('finance.skill-migration.exchange.v2');expect(manifest.state).toBe('TECHNICALLY_VALIDATED_DRAFT');

    const legacyPath=path.join(data,'migrations',`${project.id}.json`),legacy=JSON.parse(await readFile(legacyPath,'utf8'));
    legacy.schemaVersion='finance.skill-migration.v0.1';legacy.candidate={...candidate};await writeFile(legacyPath,JSON.stringify(legacy));
    const upgraded=(await post(`/api/migrations/${project.id}/upgrade`)).json();
    expect(upgraded.id).not.toBe(project.id);expect(upgraded.schemaVersion).toBe('finance.skill-migration.v2');expect(upgraded.source.assetId).toBe(candidate.assetId);expect(upgraded.legacySourceProjectId).toBe(project.id);
    expect(JSON.parse(await readFile(legacyPath,'utf8')).schemaVersion).toBe('finance.skill-migration.v0.1');
  }finally{await app.close();}
});

it('prepares a Python Script Tool from its pyproject before technical validation',async()=>{
  vi.stubEnv('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS','1');
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-v2-pyproject-'));dirs.push(data);
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false});
  const headers={authorization:'Bearer test'},post=(url:string,payload:unknown={})=>app.inject({method:'POST',url,headers,payload});
  try{
    const archive={
      'SKILL.md':'---\nname: project-script\ndescription: 使用项目化脚本处理测试输入。\n---\n调用 `project_tool`，失败时说明原因。',
      'pyproject.toml':'[project]\nname="project-script-tool"\nversion="0.1.0"\nrequires-python=">=3.11"\ndependencies=[]\n',
      'scripts/project_tool.py':'import json,sys\ndef project_tool(value): return {"received": value}\nif __name__ == "__main__": json.dump(project_tool(json.load(sys.stdin)),sys.stdout)',
    };
    const zip=Buffer.from(zipSync(Object.fromEntries(Object.entries(archive).map(([name,value])=>[name,strToU8(value)]))));
    const uploaded=(await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:zip})).json();
    const project=(await post('/api/migrations',{sourceAssetId:uploaded.assetId,name:'project script'})).json();
    const inspection=(await post(`/api/migrations/${project.id}/inspect`)).json(),tool=inspection.tools[0];
    const result=await post(`/api/migrations/${project.id}/validate/technical`,{toolId:tool.toolId,baseAssetId:uploaded.assetId,request:{amount:12}});
    expect(result.statusCode).toBe(200);expect(result.json().status).toBe('PASSED');expect(result.json().stages.find((s:{name:string})=>s.name==='STRUCTURED_OUTPUT').passed).toBe(true);
  }finally{await app.close();}
});
