import { taskHttpFixture, standardFiles, encode } from './task-http-fixture.js';
import { mkdtemp,readdir,rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach,expect,it,vi } from 'vitest';
import { strToU8,unzipSync,zipSync } from 'fflate';
import { validateSkill } from '../src/migration/domain/migration-skill-validator.js';
import { SKILL_MD, analysisFixture, analyzedTool, implementationFixture, inspectionFixture, toolFixture } from './analysis-fixture.js';
import { buildMigrationPlan } from '../src/migration/domain/migration-model.js';
import { LocalWorker } from '../src/service/local-worker.js';
import { findMissingRequiredTools } from '../src/service/run-manager.js';
import { createEvaluationService } from '../src/service/server.js';
import { generatePortableCandidate } from '../src/migration/infrastructure/migration-candidate-packager.js';
import {reusePlannerFixture,approveReuseOverHttp} from './reuse-design-fixture.js';

const dirs:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});

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

it("uses one whole-workspace analysis and immutable generation for one or multiple Skills",async()=>{

 for(const count of [1,3]){const f=await taskHttpFixture({count});const task=await f.candidate();expect(task.source.members).toHaveLength(count);expect(task.candidates[0]?.members).toHaveLength(count);
 expect(f.seen.map(x=>x.mode)).toEqual(['ANALYZE','GENERATE']);expect(f.seen.every(x=>x.source.members.length===count)).toBe(true);}

});

it("exports all frozen members and resources with an explicitly unverified manifest",async()=>{

 const f=await taskHttpFixture({count:3});await f.candidate();const files=await f.exported();
 for(const name of Object.keys(f.files))expect(Buffer.from(files['package/'+name]!)).toEqual(Buffer.from(f.files[name]!,'base64'));
 const manifest=JSON.parse(Buffer.from(files['migration/manifest.json']!).toString());expect(manifest).not.toMatchObject({verified:true});
 expect((await f.api('GET',f.url()+'/export?verified=true')).statusCode).toBe(409);

});

it("keeps user-defined acceptance inputs separate from generated candidate content",async()=>{

 const f=await taskHttpFixture();await f.ready();const before=(await f.get()).suite;
 f.control.files={...f.files,'shared/rules.json':encode('{"fake_expected_answer":"always pass"}')};await f.finish('generate');expect((await f.get()).suite).toEqual(before);
 expect(JSON.stringify(f.seen)).not.toContain('HOLDOUT_SECRET');

});

it("refuses acceptance before a generated candidate and complete configuration",async()=>{

 const f=await taskHttpFixture();expect((await f.start('acceptance')).statusCode).toBe(409);
 await f.candidate();expect((await f.start('acceptance')).statusCode).toBe(409);
 await f.api('PUT',f.url()+'/suite',{name:'Suite',cases:[{id:'dev',input:'Review',criteria:['Evidence']}]});expect((await f.start('acceptance')).statusCode).toBe(409);

});

it("preserves abstention instead of publishing placeholder candidate files",async()=>{

 const f=await taskHttpFixture();await f.finish('analysis');f.control.abstain='Missing implementation contract';const task=await f.finish('generate');
 expect(task.attempts.at(-1)).toMatchObject({status:'FAILED',error:expect.stringContaining('Missing implementation contract')});expect(task.currentCandidateId).toBeNull();expect(task.candidates).toHaveLength(0);

});

it("preserves declared prepare commands and dependency bytes for Runtime startup",async()=>{

 const f=await taskHttpFixture({files:{...standardFiles,'server.py':encode('print("fixture")'),'pyproject.toml':encode('[project]\nname="test"\nversion="1"')}});
 f.control.services=[{toolNames:['lookup'],filePaths:['server.py','pyproject.toml'],start:['python','server.py'],prepare:['python','-m','pip','install','.']}];
 const task=await f.candidate();expect(task.candidates[0]?.services).toEqual(f.control.services);
 expect(await f.file('pyproject.toml',task.currentCandidateId!)).toContain('name="test"');

});

it("blocks incomplete analysis and rejects a partially generated member set",async()=>{

 const f=await taskHttpFixture({count:3});f.control.analysis.missing=['Missing tool contract'];await f.finish('analysis');expect((await f.start('generate')).statusCode).toBe(409);
 f.control.analysis={...f.control.analysis,missing:[]};await f.finish('analysis');f.control.files={...f.files};delete f.control.files['skills/member-0/SKILL.md'];
 const task=await f.finish('generate');expect(task.attempts.at(-1)?.status).toBe('FAILED');expect(task.candidates).toHaveLength(0);

});
