import { mkdtemp,readFile,readdir,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach,expect,it,vi } from 'vitest';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { validateSkill } from '../src/service/skill-validator.js';
import { SKILL_MD, analysisFixture, analyzedTool, implementationFixture, inspectionFixture, toolFixture } from './analysis-fixture.js';
import { buildMigrationPlan } from '../src/migration/domain/migration-model.js';
import { LocalWorker } from '../src/service/local-worker.js';
import { findMissingRequiredTools } from '../src/service/run-manager.js';
import { createEvaluationService } from '../src/service/server.js';
import { generatePortableCandidate } from '../src/migration/infrastructure/migration-candidate-packager.js';
import { MigrationCodeGenerator } from '../src/migration/infrastructure/migration-code-generator.js';

const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const INCOMPLETE_PY='import json\ndef lookup(value):\n    return {"value": value}\n';
const COMPLETE_PY='import json,sys\ndef lookup(value):\n    return {"value": value}\nif __name__ == "__main__": json.dump(lookup(json.load(sys.stdin)), sys.stdout)\n';
// The path this test exercises reuses a Script that is already executable, so no model may be
// consulted. Failing loudly here is what makes that a claim rather than an assumption.
const unreachableMigrationModel=()=>({configured:true,model:{providerId:'test',modelId:'unreachable',parameters:{}},adapter:{adapterId:'unreachable',async complete(){
  throw new Error('这条迁移路径不该调用代码生成模型');
}}});

it('checks the enterprise Skill baseline without treating tool language as compliance',()=>{
  const files={'account-balance/SKILL.md':'---\nname: account-balance\ndescription: 查询余额，用户询问账户资金时使用。\n---\n调用 `get_balance`。失败时不要编造。\n'};
  expect(validateSkill(files,'account-balance/SKILL.md')).toEqual({status:'COMPLIANT',findings:[]});
  expect(validateSkill({'temporary-upload-folder/SKILL.md':files['account-balance/SKILL.md']!},'temporary-upload-folder/SKILL.md').findings).toEqual([]);
  const invalid=validateSkill({'bad/SKILL.md':'---\nname: Bad_Name\n---\nUse C:\\private\\tool.py'},'bad/SKILL.md');
  expect(invalid.status).toBe('NON_COMPLIANT');
  expect(invalid.findings.map(f=>f.code)).toEqual(expect.arrayContaining(['NAME_INVALID','DESCRIPTION_REQUIRED','ABSOLUTE_PATH']));
});

// Tool discovery, portability classification and Schema reading used to be rules here. They are
// now the A2 analysis: a judgement about what a package's tools are, made with citations rather
// than by pattern-matching prose and source literals. It is not unit-testable without an agent,
// which is the point -- so the rules-side assertions moved to tests/analysis-contract.test.ts
// (what the platform accepts from an analysis) and to the skill package's analysis-rules.md.

it('allows local Script Tools to satisfy OpenJiuwen required Tool bindings',()=>{
  expect(findMissingRequiredTools(['lookup','calculate'],[],[{name:'lookup',path:'scripts/lookup.py',kind:'PYTHON',filePaths:['scripts/lookup.py']}])).toEqual(['calculate']);
});

it('requires one migration choice per tool and groups MCP choices',()=>{
  const inspection=inspectionFixture([
    toolFixture({name:'bound_tool',sourcePaths:['bound.py'],language:'Python',portability:'RUNTIME_BOUND'}),
    toolFixture({name:'mcp_tool',sourcePaths:['mcp.js'],language:'JavaScript',portability:'PORTABLE_MCP',kind:'MCP',recommendedForm:'MCP',recommendedLanguage:'node'}),
  ],'a');
  const byName=Object.fromEntries(inspection.tools.map(t=>[t.name,t]));
  const decisions=[{toolId:byName.mcp_tool!.toolId,form:'MCP' as const,reason:'共享服务',baseAssetId:'a',decidedAt:'now'},
    {toolId:byName.bound_tool!.toolId,form:'SCRIPT' as const,reason:'本地任务',baseAssetId:'a',decidedAt:'now'}];
  const plan=buildMigrationPlan(inspection,decisions,'a');
  expect(plan.generationAllowed).toBe(true);expect(plan.items.map(i=>i.generator)).toEqual(['COMMAND_SCRIPT','MCP_SERVICE']);
  expect(buildMigrationPlan(inspection,[decisions[0]!], 'a').generationAllowed).toBe(false);
});

it('turns every Skill-spec violation into a migration item and normalizes the candidate',()=>{
  const source='---\nname: Bad_Name\n---\n调用 `run.py` 和 `references/missing.md`，token = "not-a-real-token"，失败时返回原因。';
  const misplaced=validateSkill({'skill/SKILL.md':source,'skill/run.py':'print("bad")','tool/src/service.py':'print("tool")'},'skill/SKILL.md');
  expect(misplaced.status).toBe('NON_COMPLIANT');
  expect(misplaced.findings).toContainEqual(expect.objectContaining({code:'SCRIPT_OUTSIDE_SCRIPTS',path:'skill/run.py'}));
  expect(misplaced.findings.some(item=>item.path.startsWith('tool/'))).toBe(false);
  const blocked={...inspectionFixture([],'bad-layout'),skill:validateSkill({'skill/SKILL.md':source,'skill/run.py':'print("bad")'},'skill/SKILL.md')};
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

// The platform used to render the Java MCP service from a template (pinned SDK, shaded jar,
// generated adapter). It does not any more: the service is the agent's, and its shape is asserted
// where it belongs -- tests/mcp-scaffold.test.ts for placement, and the contract test for what it
// advertises. There is nothing left here to pin.

it('packages model-migrated Runtime code with its real business implementation intact',()=>{
  const skill='---\nname: runtime-business\ndescription: 迁移真实订单计算工具。\n---\n调用 `calculate_total`。';
  const runtime='from decimal import Decimal\nfrom agentscope.tool import ToolResponse\n\ndef calculate_total(subtotal: str, rate: str) -> ToolResponse:\n    tax = Decimal(subtotal) * Decimal(rate)\n    return ToolResponse(content={"total": str(Decimal(subtotal) + tax)})\n\ndef register(toolkit):\n    toolkit.register_tool_function(tool_func=calculate_total)\n';
  const archive={'skill/SKILL.md':strToU8(skill),'tool/runtime.py':strToU8(runtime)};
  const inspection=inspectionFixture([toolFixture({name:'calculate_total',sourcePaths:['tool/runtime.py'],language:'Python',portability:'RUNTIME_BOUND'})]);
  const tool=inspection.tools[0]!;
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
  vi.stubEnv('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS','1');
  const skill='---\nname: model-migration\ndescription: 测试模型迁移。\n---\n调用 `lookup`。',runtime='from vendor.runtime import Result\ndef lookup(value): return Result(value)';
  const archive={'skill/SKILL.md':strToU8(skill),'tool/runtime.py':strToU8(runtime)};
  const inspection=inspectionFixture([toolFixture({toolId:'lookup-id',name:'lookup',sourcePaths:['tool/runtime.py'],language:'Python',portability:'RUNTIME_BOUND'})]);
  let prompt='',calls=0;const generator=new MigrationCodeGenerator(()=>({configured:true,model:{providerId:'test',modelId:'migration-model',parameters:{}},adapter:{adapterId:'fake',async complete(request){prompt=request.messages.at(-1)!.content;calls++;
    const source=calls===1?INCOMPLETE_PY:COMPLETE_PY;
    return {modelId:'migration-model',content:JSON.stringify({implementations:[{toolId:'lookup-id',toolName:'lookup',language:'python',entrypoint:'lookup.py',files:[{path:'lookup.py',content:source}],dependencies:[],smokeInput:{},explanation:'移除 vendor runtime 并生成纯 Python 业务实现'}]})};}}}));
  const result=await generator.generate({archive,inspection,decisions:[{toolId:'lookup-id',form:'SCRIPT',reason:'local',baseAssetId:'asset',decidedAt:'now'}]});
  expect(calls).toBe(2);expect(prompt).toContain('缺少同名业务函数或 JSON 主入口');expect(result['lookup-id']?.source).toContain('json.dump');expect(result['lookup-id']?.language).toBe('python');expect(result['lookup-id']?.generatedBy).toBe('test/migration-model');
});

it('refuses semantic migration when no migration model is configured',async()=>{
  const generator=new MigrationCodeGenerator(()=>({configured:false,model:{providerId:'none',modelId:'none',parameters:{}},adapter:null}));
  const inspection=inspectionFixture([toolFixture({toolId:'t',name:'tool',sourcePaths:['tool/x.py'],language:'Python',portability:'RUNTIME_BOUND'})]);
  await expect(generator.generate({archive:{'tool/x.py':strToU8('def x(): pass')},inspection,decisions:[{toolId:'t',form:'SCRIPT',reason:'local',baseAssetId:'asset',decidedAt:'now'}]})).rejects.toThrow('尚未配置 MIGRATION');
});

it('runs a trusted one-shot job with JSON IO and always cleans its directory',async()=>{
  vi.stubEnv('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS','1');
  const root=await mkdtemp(path.join(os.tmpdir(),'local-worker-test-'));dirs.push(root);
  const worker=new LocalWorker(root),script='let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({ok:JSON.parse(s).value})));';
  const result=await worker.run({requestId:'test',program:'node',args:['tool.js'],files:[{path:'tool.js',content:Buffer.from(script)}],stdin:'{"value":7}'});
  expect(result.mode).toBe('LOCAL_TRUSTED');expect(result.exitCode).toBe(0);expect(JSON.parse(result.stdout)).toEqual({ok:7});expect(await readdir(root)).toEqual([]);
  const controller=new AbortController(),cancelled=worker.run({requestId:'cancel',program:'node',args:['wait.js'],files:[{path:'wait.js',content:Buffer.from('setInterval(()=>{},1000)')}],signal:controller.signal});
  setTimeout(()=>controller.abort(),30);expect((await cancelled).cancelled).toBe(true);expect(await readdir(root)).toEqual([]);
  // Cancelled while the request is still being set up. The signal fires before anything is
  // listening, so a worker that only waits for the next event runs the whole timeout instead --
  // which is what made this file flaky on a loaded machine.
  const early=new AbortController(),earlyWork=worker.run({requestId:'early-cancel',program:'node',args:['wait.js'],files:[{path:'wait.js',content:Buffer.from('setInterval(()=>{},1000)')}],signal:early.signal});
  early.abort();
  expect((await earlyWork).cancelled).toBe(true);expect(await readdir(root)).toEqual([]);
  await expect(worker.run({requestId:'bad',program:'cmd.exe',args:[],files:[]})).rejects.toThrow('not allowed');
  await expect(worker.run({requestId:'bad-path',program:'node',args:[],files:[{path:'../escape',content:Buffer.from('')}]})).rejects.toThrow('Unsafe');
});

it('exposes the v2 inspection, mixed decisions and immutable generated candidate over HTTP',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-v2-http-'));dirs.push(data);
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false,
    migrationAnalyzer:analysisFixture([
      analyzedTool({name:'portable_mcp',sourcePaths:['tool/scripts/portable_mcp.py'],portability:'RUNTIME_BOUND'}),
      analyzedTool({name:'script_tool',sourcePaths:['tool/scripts/script_tool.py'],portability:'PORTABLE_SCRIPT',form:'SCRIPT',entrypoint:{kind:'PYTHON',path:'tool/scripts/script_tool.py'}}),
      analyzedTool({name:'bound_tool',sourcePaths:['tool/scripts/bound_tool.py'],portability:'RUNTIME_BOUND'}),
    ]),
    // The A4 agent owns the service now, so the test stands one in -- the same seam a live run
    // uses, and the placer treats these files exactly like the agent's real output.
    migrationImplementer:implementationFixture([
      {tool:'portable_mcp',entrypoint:'mcp-java/src/main/java/com/finance/migration/Server.java',language:'java',
       start:['java','-jar','mcp-java/target/service.jar'],
       files:{'mcp-java/pom.xml':'<project>portable</project>','mcp-java/src/main/java/com/finance/migration/Server.java':'class Server { PortableMcpTool.specification(mapper) }'}},
      {tool:'bound_tool',entrypoint:'mcp-java/src/main/java/com/finance/migration/Server.java',language:'java',
       start:['java','-jar','mcp-java/target/service.jar'],
       files:{'mcp-java/pom.xml':'<project>portable</project>','mcp-java/src/main/java/com/finance/migration/Server.java':'class Server { PortableMcpTool.specification(mapper) }'}},
      {tool:'script_tool',entrypoint:'scripts/script_tool.py',language:'python',
       files:{'scripts/script_tool.py':'import json,sys\ndef script_tool(v): return {"tool":"script_tool","value":v}\nif __name__ == "__main__": json.dump(script_tool(json.load(sys.stdin)),sys.stdout)\n'}},
    ])});
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
      // The fixtures are Python; asking for MCP/Java is the cross-language rewrite this
      // model produces, so it has to be named rather than inferred.
      expect((await app.inject({method:'PUT',url:`/api/migrations/${project.id}/tools/${tool.toolId}/decision`,headers,payload:{form,...(form==='MCP'?{language:'java'}:{}),baseAssetId:uploaded.assetId}})).statusCode).toBe(200);}
    const plan=(await app.inject({url:`/api/migrations/${project.id}/plan`,headers})).json();expect(plan.generationAllowed).toBe(true);expect(new Set(plan.items.map((i:{generator:string})=>i.generator))).toEqual(new Set(['COMMAND_SCRIPT','MCP_SERVICE']));
    const generated=await post(`/api/migrations/${project.id}/generate`,{baseAssetId:uploaded.assetId});expect(generated.statusCode).toBe(200);
    const candidate=generated.json().candidate;expect(candidate.assetId).not.toBe(uploaded.assetId);
    const report=(await app.inject({url:`/api/migrations/${project.id}/report`,headers})).json();
    expect(report.portableGenerationDiff.some((item:{path:string})=>item.path.endsWith('Server.java'))).toBe(true);
    const exported=await app.inject({url:`/api/migrations/${project.id}/export`,headers});expect(exported.statusCode).toBe(200);
    const files=unzipSync(exported.rawPayload),names=Object.keys(files);
    // The agent's files ship as written; the platform adds nothing of its own but the Skill layout.
    expect(names.filter(name=>name==='mcp-java/pom.xml')).toHaveLength(1);
    expect(names).toContain('mcp-java/src/main/java/com/finance/migration/Server.java');
    expect(names).toContain('skill/SKILL.md');
    expect(names).toContain('skill/scripts/script_tool.py');
    expect(names.some(name=>name.startsWith('migration-generated/'))).toBe(false);
    const scriptTool=inspection.tools.find((t:{name:string})=>t.name==='script_tool');
    const scriptValidation=await post(`/api/migrations/${project.id}/validate/technical`,{toolId:scriptTool.toolId,baseAssetId:candidate.assetId,request:{value:7}});
    expect(scriptValidation.statusCode).toBe(200);
    expect((await post(`/api/migrations/${project.id}/validate/technical`,{toolId:inspection.tools.find((t:{name:string})=>t.name==='bound_tool').toolId,baseAssetId:candidate.assetId})).statusCode).not.toBe(409);
    expect((await post(`/api/migrations/${project.id}/validate/openjiuwen`,{})).statusCode).toBe(409);
  }finally{await app.close();}
});

it('exports v2 evidence states and upgrades legacy projects without changing history',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-v2-state-'));dirs.push(data);
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false,migrationAnalyzer:analysisFixture([])});
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

it('writes the test set from the analysis, and never from the generated candidate',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-suite-'));dirs.push(data);
  const seen:Array<{skillSource:string;tools:string[]}>=[];
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false,
    migrationAnalyzer:analysisFixture([analyzedTool({name:'lookup',sourcePaths:['tool/lookup.py'],inputSchema:{type:'object',properties:{account_id:{type:'string'}}},sample:{account_id:'A-1'}})]),
    // Stands in for the analyzer model: what matters is what it is handed, not what it returns.
    migrationSuite:async input=>{seen.push({skillSource:input.skillSource,tools:input.tools});
      return {summary:'基于分析生成的测试集',cases:[{caseId:'case-1',prompt:'查询 A-1 的余额',requiredTools:['lookup'],taskMode:'single_turn' as const}]};}});
  const headers={authorization:'Bearer test'},post=(url:string,payload:unknown={})=>app.inject({method:'POST',url,headers,payload});
  try{
    const archive={'skill/SKILL.md':SKILL_MD,'tool/lookup.py':'def lookup(account_id): return {}\n'};
    const uploaded=(await app.inject({method:'POST',url:'/api/migrations/upload',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync(Object.fromEntries(Object.entries(archive).map(([name,value])=>[name,strToU8(value)]))))})).json();
    const project=(await post('/api/migrations',{sourceAssetId:uploaded.assetId,name:'generated suite'})).json();
    const inspection=(await post(`/api/migrations/${project.id}/inspect`)).json();
    const suite=(await post(`/api/migrations/${project.id}/suites/generated`,{baseAssetId:uploaded.assetId})).json();
    expect(suite.source).toBe('ai_generated');
    expect(suite.cases.map((item:{caseId:string})=>item.caseId)).toEqual(['case-1']);
    // The question writer is grounded on the analysis: the tool list and the contract it read.
    expect(seen[0]!.tools).toEqual(['lookup']);
    expect(seen[0]!.skillSource).toContain('account_id');
    expect(seen[0]!.skillSource).toContain('A-1');
    expect(inspection.tools.map((tool:{name:string})=>tool.name)).toEqual(['lookup']);
    expect((await app.inject({url:`/api/migrations/${project.id}/report`,headers})).json().project.suiteIds).toEqual([suite.preparationId]);
  }finally{await app.close();}
});

it('refuses to write a test set before the analysis it would be built from',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-suite-earlier-'));dirs.push(data);
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false,
    migrationAnalyzer:analysisFixture([analyzedTool({name:'lookup',sourcePaths:['tool/lookup.py']})])});
  const headers={authorization:'Bearer test'};
  try{
    const uploaded=(await app.inject({method:'POST',url:'/api/migrations/upload',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync({'skill/SKILL.md':strToU8(SKILL_MD)}))})).json();
    const project=(await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:uploaded.assetId,name:'no analysis'}})).json();
    const result=await app.inject({method:'POST',url:`/api/migrations/${project.id}/suites/generated`,headers,payload:{baseAssetId:uploaded.assetId}});
    expect(result.statusCode).toBe(409);expect(result.json().message).toContain('分析结果');
  }finally{await app.close();}
});

it('abstains instead of shipping a placeholder when a Tool cannot be migrated faithfully',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-abstain-'));dirs.push(data);
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false,
    migrationAnalyzer:analysisFixture([analyzedTool({name:'lookup',sourcePaths:['tool/lookup.py'],portability:'RUNTIME_BOUND'})]),
    // The honest answer when the business implementation is not in the package: say so.
    migrationImplementer:async input=>({status:'ABSTAINED',
      payload:{status:'ABSTAINED',tools:[{toolId:(input.tools[0] as {toolId:string}).toolId,status:'ABSTAINED',
        reason:'业务实现在编译产物里，读不到源码',missing:['tool/orders.jar']}]},
      files:{}})});
  const headers={authorization:'Bearer test'},post=(url:string,payload:unknown={})=>app.inject({method:'POST',url,headers,payload});
  try{
    const archive={'skill/SKILL.md':SKILL_MD,'tool/lookup.py':'def lookup(account_id): return {}\n'};
    const uploaded=(await app.inject({method:'POST',url:'/api/migrations/upload',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync(Object.fromEntries(Object.entries(archive).map(([name,value])=>[name,strToU8(value)]))))})).json();
    const project=(await post('/api/migrations',{sourceAssetId:uploaded.assetId,name:'abstaining'})).json();
    const inspection=(await post(`/api/migrations/${project.id}/inspect`)).json();
    const tool=inspection.tools[0];
    await app.inject({method:'PUT',url:`/api/migrations/${project.id}/tools/${tool.toolId}/decision`,headers,payload:{form:'MCP',baseAssetId:uploaded.assetId}});
    const result=await post(`/api/migrations/${project.id}/generate`,{baseAssetId:uploaded.assetId});
    expect(result.statusCode).toBe(409);
    expect(result.json().message).toContain('无法忠实迁移');
    // Named, so the reader knows which Tool to go and fix, and told what is missing.
    expect(result.json().message).toContain(tool.toolId);
    expect(result.json().message).toContain('读不到源码');
    expect(result.json().message).toContain('tool/orders.jar');
    // An abstention is a decision, so nothing is delivered: no candidate, no generated files.
    const report=(await app.inject({url:`/api/migrations/${project.id}/report`,headers})).json();
    expect(report.project.candidate).toBeNull();
    expect(report.project.portableGenerations??[]).toEqual([]);
  }finally{await app.close();}
});

it('prepares a Python Script Tool from its pyproject before technical validation',async()=>{
  vi.stubEnv('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS','1');
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-v2-pyproject-'));dirs.push(data);
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false,
    migrationAnalyzer:analysisFixture([analyzedTool({name:'project_tool',sourcePaths:['scripts/project_tool.py'],portability:'PORTABLE_SCRIPT',form:'SCRIPT',
      entrypoint:{kind:'PYTHON',path:'scripts/project_tool.py'}})])});
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
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false,migrationModel:unreachableMigrationModel,
    // The scanner's coverage rides along with the analysis; it is what says "this file was not read".
    migrationAnalyzer:async()=>({status:'PRODUCED',payload:{status:'PRODUCED',skill:{status:'COMPLIANT',findings:[]},tools:[
      analyzedTool({name:'script_tool',sourcePaths:['tool/scripts/script_tool.py','tool/vendor/opaque.js'],portability:'PORTABLE_SCRIPT',form:'SCRIPT',
        entrypoint:{kind:'PYTHON',path:'tool/scripts/script_tool.py'}})],dependencyAnalysis:{dependencies:[],chains:[{toolName:'script_tool',nodes:[{id:'entry',title:'Script entry',detail:'Source implementation is readable; vendor coverage is acknowledged separately',dependencyKeys:[],evidence:[{path:'tool/scripts/script_tool.py',snippet:'def script_tool(value): return {"value": value}'}]}],edges:[]}]}},
      scanner:{scannerDigest:'a'.repeat(64),coverage:[{path:'skill/SKILL.md',status:'PARSED'},{path:'tool/vendor/opaque.js',status:'UNSUPPORTED_LANGUAGE'}]}})});
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
