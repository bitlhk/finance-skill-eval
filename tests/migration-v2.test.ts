import { mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { validateSkill } from '../src/service/skill-validator.js';
import { inspectProject } from '../src/service/tool-inspector.js';
import { buildMigrationPlan } from '../src/service/migration-model.js';
import { LocalWorker } from '../src/service/local-worker.js';
import { findMissingRequiredTools } from '../src/service/run-manager.js';
import { createEvaluationService } from '../src/service/server.js';
import { generatePortableCandidate } from '../src/service/portable-candidate.js';
import { MigrationCodeGenerator } from '../src/service/migration-code-generator.js';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const javaBusiness=(className:string)=>`package com.finance.migration.business;\nimport java.util.LinkedHashMap;\nimport java.util.Map;\npublic final class ${className} {\n  public static Object execute(Map<String,Object> arguments) throws Exception { return new LinkedHashMap<>(arguments); }\n}\n`;
const javaMigrationModel=()=>({configured:true,model:{providerId:'test',modelId:'java-migration',parameters:{}},adapter:{adapterId:'java-migration-fake',async complete(request:{messages:Array<{content:string}>}){
  const payload=JSON.parse(request.messages.at(-1)!.content),implementations=payload.tools.map((tool:{toolId:string;name:string;requiredJavaClass:string})=>({toolId:tool.toolId,toolName:tool.name,language:'java',entrypoint:`${tool.requiredJavaClass}.java`,entryClass:tool.requiredJavaClass,files:[{path:`${tool.requiredJavaClass}.java`,content:javaBusiness(tool.requiredJavaClass)}],dependencies:[],smokeInput:{},explanation:'pure Java semantic migration'}));
  return {modelId:'java-migration',content:JSON.stringify({implementations})};
}}});

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
  const decisions=[{toolId:byName.mcp_tool!.toolId,form:'MCP' as const,reason:'共享服务',baseAssetId:'a',decidedAt:'now'},
    {toolId:byName.bound_tool!.toolId,form:'SCRIPT' as const,reason:'本地任务',baseAssetId:'a',decidedAt:'now'}];
  const plan=buildMigrationPlan(inspection,decisions,'a');
  expect(plan.generationAllowed).toBe(true);expect(plan.items.map(i=>i.generator)).toEqual(['SCRIPT_TOOL','MCP_SERVICE']);
  expect(buildMigrationPlan(inspection,[decisions[0]!], 'a').generationAllowed).toBe(false);
});

it('turns every Skill-spec violation into a migration item and normalizes the candidate',()=>{
  const source='---\nname: Bad_Name\n---\n调用 `run.py` 和 `references/missing.md`，token = "not-a-real-token"，失败时返回原因。';
  const misplaced=validateSkill({'skill/SKILL.md':source,'skill/run.py':'print("bad")','tool/src/service.py':'print("tool")'},'skill/SKILL.md');
  expect(misplaced.status).toBe('NON_COMPLIANT');
  expect(misplaced.findings).toContainEqual(expect.objectContaining({code:'SCRIPT_OUTSIDE_SCRIPTS',path:'skill/run.py'}));
  expect(misplaced.findings.some(item=>item.path.startsWith('tool/'))).toBe(false);
  const blocked=inspectProject({assetId:'bad-layout',assetDigest:'a'.repeat(64),files:{'skill/SKILL.md':source,'skill/run.py':'print("bad")'},skillFile:'skill/SKILL.md'});
  expect(buildMigrationPlan(blocked,[],'bad-layout')).toEqual(expect.objectContaining({generationAllowed:true,skillBlockingReasons:[],skillMigrationItems:expect.arrayContaining([expect.stringContaining('SCRIPT_OUTSIDE_SCRIPTS')])}));
  const archive={'skill/SKILL.md':strToU8(source),'skill/run.py':strToU8('print("bad")'),'skill/notes/readme.txt':strToU8('notes'),'skill/nested/SKILL.md':strToU8('legacy')};
  const generated=generatePortableCandidate({archive,base:{schemaVersion:'finance.skill-eval.skill-asset.v1',assetId:'bad-layout',skillId:'Bad_Name',version:'1',displayName:'bad',description:'bad',sourceType:'uploaded',artifactSha256:'a'.repeat(64),skillFile:'skill/SKILL.md',fileCount:2,createdAt:'now'},inspection:blocked,decisions:[],version:'2.0.0'});
  expect(Buffer.from(generated.files['scripts/run.py']!).toString()).toBe('print("bad")');
  expect(Buffer.from(generated.files['references/notes/readme.txt']!).toString()).toBe('notes');
  expect(generated.files['references/legacy-nested-SKILL.md']).toBeDefined();
  const normalized=Buffer.from(generated.files['SKILL.md']!).toString();
  expect(normalized).toContain('name: bad-name');expect(normalized).toContain('description:');expect(normalized).toContain('`scripts/run.py`');expect(normalized).not.toContain('`references/missing.md`');expect(normalized).not.toContain('not-a-real-token');
  const candidateSkill=validateSkill(Object.fromEntries(Object.entries(generated.files).map(([name,bytes])=>[name,Buffer.from(bytes).toString()])), 'SKILL.md');
  expect(candidateSkill.findings.filter(item=>item.severity==='ERROR')).toEqual([]);
  const compliant='---\nname: package-layout\ndescription: \u9a8c\u8bc1 Skill \u5305\u76ee\u5f55\u7ed3\u6784\u3002\n---\n\u8c03\u7528\u811a\u672c\uff0c\u5931\u8d25\u65f6\u8fd4\u56de\u539f\u56e0\u3002';
  expect(validateSkill({'skill/SKILL.md':compliant,'skill/scripts/run.py':'print("ok")','skill/references/rules.md':'rules'},'skill/SKILL.md').status).toBe('COMPLIANT');
  expect(validateSkill({'skill/skill.md':source},'skill/skill.md').findings).toContainEqual(expect.objectContaining({code:'SKILL_FILENAME_INVALID'}));
});

it('generates a version-pinned executable Java MCP service instead of a placeholder',()=>{
  const skill='---\nname: deployable-mcp\ndescription: 测试可部署 MCP 生成。\n---\n调用 `lookup`，失败时返回原因。';
  const archive={'skill/SKILL.md':strToU8(skill),'tool/scripts/lookup.py':strToU8('import json,sys\ndef lookup(value): return {"value": value}\nif __name__ == "__main__": json.dump(lookup(json.load(sys.stdin)),sys.stdout)')};
  const inspection=inspectProject({assetId:'asset',assetDigest:'d'.repeat(64),files:Object.fromEntries(Object.entries(archive).map(([name,value])=>[name,Buffer.from(value).toString()])),skillFile:'skill/SKILL.md'});
  const tool=inspection.tools[0]!;
  const business=javaBusiness('LookupBusiness');
  const generated=generatePortableCandidate({archive,base:{schemaVersion:'finance.skill-eval.skill-asset.v1',assetId:'asset',skillId:'deployable-mcp',version:'1.0.0',displayName:'deployable',description:'test',sourceType:'uploaded',artifactSha256:'d'.repeat(64),skillFile:'skill/SKILL.md',fileCount:2,createdAt:'now'},inspection,decisions:[{toolId:tool.toolId,form:'MCP',reason:'portable',baseAssetId:'asset',decidedAt:'now'}],version:'2.0.0',implementations:{[tool.toolId]:{language:'java',sourcePath:'LookupBusiness.java',source:business,additionalFiles:[],dependencies:[],entryClass:'LookupBusiness',smokeInput:{},generatedBy:'test/java',explanation:'pure Java',attempts:1,checks:[{name:'JAVA_COMPILE',passed:true,message:'compiled'}]}}});
  const text=(name:string)=>Buffer.from(generated.files[name]!).toString();
  expect(text('mcp/pom.xml')).toContain('<mcp.java.sdk.version>1.1.4</mcp.java.sdk.version>');
  expect(text('mcp/pom.xml')).toContain('<artifactId>maven-shade-plugin</artifactId>');
  expect(text('mcp/src/main/java/com/finance/migration/MigrationMcpServer.java')).toContain('HttpServletStreamableServerTransportProvider');
  expect(text('mcp/src/main/java/com/finance/migration/MigrationMcpServer.java')).toContain('.tools(LookupTool.specification(mapper))');
  expect(text('mcp/src/main/java/com/finance/migration/tools/LookupTool.java')).toContain('LookupBusiness.execute(arguments)');
  expect(text('mcp/src/main/java/com/finance/migration/business/LookupBusiness.java')).toContain('public static Object execute');
  expect(Object.keys(generated.files).some(name=>name.endsWith('.py'))).toBe(false);
  expect(text('mcp/Dockerfile')).not.toContain('uv');
  expect(text('mcp/src/main/java/com/finance/migration/tools/LookupTool.java')).not.toContain('BUSINESS_IMPLEMENTATION_NOT_CONNECTED');
  expect(generated.files['mcp/Dockerfile']).toBeDefined();
});

it('packages model-migrated Runtime code with its real business implementation intact',()=>{
  const skill='---\nname: runtime-business\ndescription: 迁移真实订单计算工具。\n---\n调用 `calculate_total`。';
  const runtime='from decimal import Decimal\nfrom agentscope.tool import ToolResponse\n\ndef calculate_total(subtotal: str, rate: str) -> ToolResponse:\n    tax = Decimal(subtotal) * Decimal(rate)\n    return ToolResponse(content={"total": str(Decimal(subtotal) + tax)})\n\ndef register(toolkit):\n    toolkit.register_tool_function(tool_func=calculate_total)\n';
  const archive={'skill/SKILL.md':strToU8(skill),'tool/runtime.py':strToU8(runtime)};
  const files=Object.fromEntries(Object.entries(archive).map(([name,value])=>[name,Buffer.from(value).toString()]));
  const inspection=inspectProject({assetId:'asset',assetDigest:'e'.repeat(64),files,skillFile:'skill/SKILL.md'}),tool=inspection.tools[0]!;
  expect(tool.portability).toBe('RUNTIME_BOUND');
  const migrated='from decimal import Decimal\nimport json, sys\ndef calculate_total(subtotal: str, rate: str):\n    tax = Decimal(subtotal) * Decimal(rate)\n    return {"total": str(Decimal(subtotal) + tax)}\nif __name__ == "__main__":\n    json.dump(calculate_total(**json.load(sys.stdin)), sys.stdout)\n';
  const generated=generatePortableCandidate({archive,base:{schemaVersion:'finance.skill-eval.skill-asset.v1',assetId:'asset',skillId:'runtime-business',version:'1.0.0',displayName:'runtime',description:'test',sourceType:'uploaded',artifactSha256:'e'.repeat(64),skillFile:'skill/SKILL.md',fileCount:2,createdAt:'now'},inspection,decisions:[{toolId:tool.toolId,form:'SCRIPT',reason:'local',baseAssetId:'asset',decidedAt:'now'}],version:'2.0.0',implementations:{[tool.toolId]:{language:'python',sourcePath:'model-generated/calculate_total.py',source:migrated,additionalFiles:[],dependencies:[],smokeInput:{},generatedBy:'test/model',explanation:'semantic port',attempts:1,checks:[{name:'PYTHON_COMPILE',passed:true,message:'compiled'},{name:'JSON_SMOKE',passed:true,message:'smoked'}]}}});
  const script=Buffer.from(generated.files['scripts/calculate_total.py']!).toString();
  expect(script).toContain('tax = Decimal(subtotal) * Decimal(rate)');
  expect(script).toContain('calculate_total(**json.load(sys.stdin))');
  expect(script).not.toContain('from agentscope.tool import ToolResponse');
  expect(script).not.toContain('register_tool_function');
  expect(generated.generations[0]).toMatchObject({readyForValidation:true,todo:[]});
});

it('uses a migration model for Runtime-bound code and validates the returned complete entrypoint',async()=>{
  const skill='---\nname: model-migration\ndescription: 测试模型迁移。\n---\n调用 `lookup`。',runtime='from vendor.runtime import Result\ndef lookup(value): return Result(value)';
  const archive={'skill/SKILL.md':strToU8(skill),'tool/runtime.py':strToU8(runtime)},files=Object.fromEntries(Object.entries(archive).map(([name,value])=>[name,Buffer.from(value).toString()]));
  const inspection=inspectProject({assetId:'asset',assetDigest:'f'.repeat(64),files,skillFile:'skill/SKILL.md'});
  inspection.tools=[{...inspection.tools[0]!,toolId:'lookup-id',name:'lookup',portability:'RUNTIME_BOUND',language:'Python',sourcePaths:['tool/runtime.py']}];
  let prompt='',calls=0;const generator=new MigrationCodeGenerator(()=>({configured:true,model:{providerId:'test',modelId:'migration-model',parameters:{}},adapter:{adapterId:'fake',async complete(request){prompt=request.messages.at(-1)!.content;calls++;
    const source=calls===1?'package com.finance.migration.business; import java.util.Map; public final class LookupBusiness { public static Object execute(Map<String,Object> arguments) throws Exception { return arguments } }':javaBusiness('LookupBusiness');
    return {modelId:'migration-model',content:JSON.stringify({implementations:[{toolId:'lookup-id',toolName:'lookup',language:'java',entrypoint:'LookupBusiness.java',entryClass:'LookupBusiness',files:[{path:'LookupBusiness.java',content:source}],dependencies:[],smokeInput:{},explanation:'移除 vendor runtime 并生成纯 Java 业务实现'}]})};}}}));
  const result=await generator.generate({archive,inspection,decisions:[{toolId:'lookup-id',form:'MCP',reason:'shared',baseAssetId:'asset',decidedAt:'now'}]});
  expect(calls).toBe(2);expect(prompt).toContain('Java 编译失败');expect(result['lookup-id']?.source).toContain('class LookupBusiness');expect(result['lookup-id']?.language).toBe('java');expect(result['lookup-id']?.generatedBy).toBe('test/migration-model');expect(result['lookup-id']?.checks).toHaveLength(1);
});

it('refuses semantic migration when no migration model is configured',async()=>{
  const generator=new MigrationCodeGenerator(()=>({configured:false,model:{providerId:'none',modelId:'none',parameters:{}},adapter:null}));
  const inspection={assetId:'asset',assetDigest:'a'.repeat(64),skill:{status:'COMPLIANT' as const,findings:[]},scriptsExecuted:false as const,tools:[{toolId:'t',name:'tool',sourcePaths:['tool/x.java'],language:'Java',kind:'RUNTIME' as const,portability:'RUNTIME_BOUND' as const,recommendedForm:'MCP' as const,recommendedLanguage:'java',recommendationReason:'test',findings:[],evidence:[]} ]};
  await expect(generator.generate({archive:{'tool/x.java':strToU8('class X {}')},inspection,decisions:[{toolId:'t',form:'MCP',reason:'shared',baseAssetId:'asset',decidedAt:'now'}]})).rejects.toThrow('尚未配置 MIGRATION');
});

it('runs a trusted one-shot job with JSON IO and always cleans its directory',async()=>{
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
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false,migrationModel:javaMigrationModel});
  const headers={authorization:'Bearer test'},post=(url:string,payload:unknown)=>(app.inject({method:'POST',url,headers,payload}));
  try{
    const cli=(name:string)=>`import json,sys\ndef ${name}(v): return {"tool":"${name}","value":v}\nif __name__ == "__main__": json.dump(${name}(json.load(sys.stdin)),sys.stdout)`;
    const archive={'skill/SKILL.md':'---\nname: mixed-tools\ndescription: 使用多个工具处理测试任务。\n---\n调用 `portable_mcp`、`script_tool` 和 `bound_tool`。失败时返回原因。',
      'tool/scripts/portable_mcp.py':cli('portable_mcp'),'tool/scripts/script_tool.py':cli('script_tool'),'tool/scripts/bound_tool.py':cli('bound_tool')};
    const zip=Buffer.from(zipSync(Object.fromEntries(Object.entries(archive).map(([name,value])=>[name,strToU8(value)]))));
    const uploaded=(await app.inject({method:'POST',url:'/api/migrations/upload',headers:{...headers,'content-type':'application/zip'},payload:zip})).json();
    const project=(await post('/api/migrations',{sourceAssetId:uploaded.assetId,name:'mixed'})).json();
    expect(project.schemaVersion).toBe('finance.skill-migration.v2');
    const inspection=(await post(`/api/migrations/${project.id}/inspect`,{})).json();
    expect(inspection.tools).toHaveLength(3);expect(inspection.scriptsExecuted).toBe(false);
    for(const tool of inspection.tools){const form=tool.name==='script_tool'?'SCRIPT':'MCP';
      expect((await app.inject({method:'PUT',url:`/api/migrations/${project.id}/tools/${tool.toolId}/decision`,headers,payload:{form,baseAssetId:uploaded.assetId}})).statusCode).toBe(200);}
    const plan=(await app.inject({url:`/api/migrations/${project.id}/plan`,headers})).json();expect(plan.generationAllowed).toBe(true);expect(new Set(plan.items.map((i:{generator:string})=>i.generator))).toEqual(new Set(['SCRIPT_TOOL','MCP_SERVICE']));
    const generated=await post(`/api/migrations/${project.id}/generate`,{baseAssetId:uploaded.assetId});expect(generated.statusCode).toBe(200);
    const candidate=generated.json().candidate;expect(candidate.assetId).not.toBe(uploaded.assetId);
    const report=(await app.inject({url:`/api/migrations/${project.id}/report`,headers})).json();
    expect(report.portableGenerationDiff.some((item:{path:string})=>item.path.endsWith('MigrationMcpServer.java'))).toBe(true);
    const exported=await app.inject({url:`/api/migrations/${project.id}/export`,headers});expect(exported.statusCode).toBe(200);
    const files=unzipSync(exported.rawPayload),names=Object.keys(files);
    expect(names.filter(name=>name==='mcp/pom.xml')).toHaveLength(1);
    expect(names).toContain('mcp/Dockerfile');
    expect(names).toContain('skill/SKILL.md');
    expect(names).toContain('skill/scripts/script_tool.py');
    expect(names.some(name=>name.startsWith('migration-generated/'))).toBe(false);
    const pom=Buffer.from(files['mcp/pom.xml']!).toString();
    expect(pom).toContain('<mcp.java.sdk.version>1.1.4</mcp.java.sdk.version>');
    expect(pom).toContain('<artifactId>maven-shade-plugin</artifactId>');
    const server=Buffer.from(files['mcp/src/main/java/com/finance/migration/MigrationMcpServer.java']!).toString();
    expect(server).toContain('HttpServletStreamableServerTransportProvider');
    expect(server).toContain('PortableMcpTool.specification(mapper)');
    expect(server).toContain('BoundToolTool.specification(mapper)');
    expect(server).toContain('context.addServlet(new ServletHolder(transport), "/mcp")');
    const portableTool=Buffer.from(files['mcp/src/main/java/com/finance/migration/tools/PortableMcpTool.java']!).toString();
    expect(portableTool).toContain('SyncToolSpecification');
    expect(portableTool).toContain('PortableMcpBusiness.execute(arguments)');
    expect(portableTool).not.toContain('ProcessBuilder');
    expect(names).toContain('mcp/src/main/java/com/finance/migration/business/PortableMcpBusiness.java');
    expect(names.some(name=>name.startsWith('mcp/')&&name.endsWith('.py'))).toBe(false);
    expect(portableTool).not.toContain('BUSINESS_IMPLEMENTATION_NOT_CONNECTED');
    const scriptTool=inspection.tools.find((t:{name:string})=>t.name==='script_tool');
    const scriptValidation=await post(`/api/migrations/${project.id}/validate/technical`,{toolId:scriptTool.toolId,baseAssetId:candidate.assetId,request:{value:7}});
    expect(scriptValidation.statusCode).toBe(200);
    expect((await post(`/api/migrations/${project.id}/validate/technical`,{toolId:inspection.tools.find((t:{name:string})=>t.name==='bound_tool').toolId,baseAssetId:candidate.assetId})).statusCode).not.toBe(409);
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
    const files=unzipSync(exported.rawPayload);
    expect(files['SKILL.md']).toBeDefined();expect(files['migration-manifest.json']).toBeUndefined();expect(files['migration-report.json']).toBeUndefined();

    const legacyPath=path.join(data,'migrations',`${project.id}.json`),legacy=JSON.parse(await readFile(legacyPath,'utf8'));
    legacy.schemaVersion='finance.skill-migration.v0.1';legacy.candidate={...candidate};await writeFile(legacyPath,JSON.stringify(legacy));
    const upgraded=(await post(`/api/migrations/${project.id}/upgrade`)).json();
    expect(upgraded.id).not.toBe(project.id);expect(upgraded.schemaVersion).toBe('finance.skill-migration.v2');expect(upgraded.source.assetId).toBe(candidate.assetId);expect(upgraded.legacySourceProjectId).toBe(project.id);
    expect(JSON.parse(await readFile(legacyPath,'utf8')).schemaVersion).toBe('finance.skill-migration.v0.1');
  }finally{await app.close();}
});

it('prepares a Python Script Tool from its pyproject before technical validation',async()=>{
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

it('blocks partially analyzed source until it is explicitly acknowledged and re-scans the candidate',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-v2-partial-'));dirs.push(data);
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false,migrationModel:javaMigrationModel});
  const headers={authorization:'Bearer test'},post=(url:string,payload:unknown={})=>app.inject({method:'POST',url,headers,payload});
  try{
    const archive={
      'skill/SKILL.md':'---\nname: partial-analysis\ndescription: 验证静态分析覆盖门禁。\n---\n调用 `script_tool`。',
      'tool/scripts/script_tool.py':'import json,sys\ndef script_tool(value): return {"value": value}\nif __name__ == "__main__": json.dump(script_tool(**json.load(sys.stdin)),sys.stdout)',
      'tool/vendor/opaque.js':'export const script_tool = loadAtRuntime();',
    };
    const zip=Buffer.from(zipSync(Object.fromEntries(Object.entries(archive).map(([name,value])=>[name,strToU8(value)]))));
    const uploaded=(await app.inject({method:'POST',url:'/api/migrations/upload',headers:{...headers,'content-type':'application/zip'},payload:zip})).json();
    const project=(await post('/api/migrations',{sourceAssetId:uploaded.assetId,name:'partial analysis'})).json();
    const inspection=(await post(`/api/migrations/${project.id}/inspect`)).json(),tool=inspection.tools[0];
    expect(inspection.staticAnalysis.status).toBe('PARTIAL');
    expect(inspection.staticAnalysis.incompleteFiles).toContainEqual({path:'tool/vendor/opaque.js',status:'UNSUPPORTED_LANGUAGE'});
    await app.inject({method:'PUT',url:`/api/migrations/${project.id}/tools/${tool.toolId}/decision`,headers,payload:{form:'SCRIPT',baseAssetId:uploaded.assetId}});
    const blocked=await post(`/api/migrations/${project.id}/generate`,{baseAssetId:uploaded.assetId});
    expect(blocked.statusCode).toBe(409);expect(blocked.json().message).toContain('人工审阅');
    const generated=await post(`/api/migrations/${project.id}/generate`,{baseAssetId:uploaded.assetId,acknowledgePartialAnalysis:true});
    expect(generated.statusCode).toBe(200);
    const result=generated.json();
    expect(result.inspection.assetId).toBe(result.candidate.assetId);
    expect(result.inspection.assetDigest).toBe(result.candidate.artifactSha256);
    expect(result.inspection.staticAnalysis.scannerDigest).toMatch(/^[a-f0-9]{64}$/u);
  }finally{await app.close();}
});
