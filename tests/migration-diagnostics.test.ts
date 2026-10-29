import { taskHttpFixture, standardFiles, encode } from './task-http-fixture.js';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it, expect, vi } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { SkillStore } from '../src/service/skill-store.js';
import { MigrationDiagnostics } from '../src/migration/infrastructure/migration-diagnostics.js';
import { inspectProject } from '../src/migration/domain/migration-project-inspector.js';
import { createEvaluationService } from '../src/service/server.js';
import type { ConfiguredModelRole } from '../src/service/config.js';
import { MigrationReportService } from '../src/migration/application/migration-report-service.js';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const method='---\nname: synthetic-method\nversion: 1.0.0\n---\nDescribe known facts. Missing is not zero.\n';
async function setup(extra:Record<string,string>={},role?:()=>ConfiguredModelRole){
  const dir=await mkdtemp(path.join(os.tmpdir(),'migration-diagnosis-'));dirs.push(dir);
  const skills=new SkillStore(dir);await skills.initialize();
  const asset=await skills.uploadZip(Buffer.from(zipSync(Object.fromEntries(Object.entries({'SKILL.md':method,...extra}).map(([p,s])=>[p,strToU8(s)])))));
  const diagnostics=new MigrationDiagnostics(path.resolve('.'),dir,skills,role??(()=>({configured:false,adapter:null,model:{providerId:'none',modelId:'none',parameters:{}}})));
  return {asset,diagnostics,dir,skills};
}
it('does not report runtime coupling for a method-only package',async()=>{
  const {asset,diagnostics}=await setup();const d=await diagnostics.diagnose(asset);
  expect(d.dependencyStatus).toBe('NO_BINDING_IN_CHECKED_SCOPE');expect(d.findings).toEqual([]);expect(d.ai.status).toBe('NOT_CONFIGURED');
});
it('scans a candidate without starting AI and can explicitly explain the same cached scan later',async()=>{
  let calls=0;
  const {asset,diagnostics}=await setup({'helper.py':'from agentscope.tool import ToolResponse\n'},()=>({configured:true,
    model:{providerId:'fixture',modelId:'fixture',parameters:{}},adapter:{adapterId:'fixture',async complete(){calls++;
      return {modelId:'fixture',content:JSON.stringify({summary:'test',suggestions:[]})};}}}));
  const staticOnly=await diagnostics.diagnose(asset,false,{explain:false});
  expect(calls).toBe(0);expect(staticOnly.ai.status).toBe('NOT_REQUESTED');
  expect(staticOnly.findings.some(f=>f.dependencyType==='SDK_IMPORT')).toBe(true);
  const explained=await diagnostics.diagnose(asset);
  expect(calls).toBe(1);expect(explained.ai.status).toBe('COMPLETE');
  expect(explained.scannerDigest).toBe(staticOnly.scannerDigest);
});
it('does not wait on a concurrent AI explanation for a static-only candidate scan',async()=>{
  let started!:()=>void,finish!:()=>void;
  const entered=new Promise<void>(resolve=>{started=resolve}),gate=new Promise<void>(resolve=>{finish=resolve});
  const {asset,diagnostics}=await setup({},()=>({configured:true,model:{providerId:'fixture',modelId:'fixture',parameters:{}},
    adapter:{adapterId:'fixture',async complete(){started();await gate;return {modelId:'fixture',content:JSON.stringify({summary:'test',suggestions:[]})};}}}));
  const explaining=diagnostics.diagnose(asset);await entered;
  try{const staticOnly=await diagnostics.diagnose(asset,false,{explain:false});expect(staticOnly.ai.status).toBe('RUNNING');}
  finally{finish();await explaining;}
});
it('reads only existing diagnosis state without invoking a model or recovering an interrupted analysis',async()=>{
  let calls=0;
  const {asset,diagnostics,dir}=await setup({},()=>{calls++;return {configured:false,adapter:null,model:{providerId:'none',modelId:'none',parameters:{}}};});
  expect(await diagnostics.peek(asset)).toBeNull();expect(calls).toBe(0);
  const diagnosis=await diagnostics.diagnose(asset);expect(calls).toBe(1);
  diagnosis.ai={status:'RUNNING',retryable:false};
  const file=path.join(dir,'migration-diagnostics',asset.artifactSha256+'.json');
  await writeFile(file,JSON.stringify(diagnosis));
  expect((await diagnostics.peek(asset))?.ai.status).toBe('RUNNING');expect(calls).toBe(1);
  diagnosis.scannerDigest='outdated';await writeFile(file,JSON.stringify(diagnosis));
  expect(await diagnostics.peek(asset)).toBeNull();expect(calls).toBe(1);
});
it('ignores SDK names in comments and docstrings, resolves aliases in actual calls',async()=>{
  const {asset,diagnostics}=await setup({'helper.py':'# from agentscope.tool import ToolResponse\n"""ToolResponse()"""\nfrom agentscope.tool import ToolResponse as Reply\ndef f():\n    return Reply(content=[])\n'});
  const d=await diagnostics.diagnose(asset);expect(d.findings.filter(f=>f.dependencyType==='SDK_IMPORT').map(f=>f.line)).toEqual([3]);
  expect(d.findings.filter(f=>f.dependencyType==='SDK_RESULT').map(f=>f.line)).toEqual([5]);
});
it('comments alone are not executable dependencies',async()=>{
  const {asset,diagnostics}=await setup({'helper.py':'# import agentscope\n# toolkit.register_tool_function(foo)\n"""from agentscope.tool import ToolResponse"""\n'});
  expect((await diagnostics.diagnose(asset)).dependencyStatus).toBe('NO_BINDING_IN_CHECKED_SCOPE');
});
it('distinguishes host registration from business pollution and reports missing resources',async()=>{
  const {asset,diagnostics}=await setup({'SKILL.md':method+'`references/rules.md` 由宿主自动注入。\n','host.py':'def register(toolkit):\n    toolkit.register_tool_function(tool_func=read, json_schema=parameters)\n'});
  const d=await diagnostics.diagnose(asset);expect(d.findings.find(f=>f.dependencyType==='TOOL_REGISTRATION')?.layer).toBe('HOST');
  expect(d.findings.some(f=>f.dependencyType==='RESOURCE_INJECTION')).toBe(true);
  expect(d.findings.some(f=>f.dependencyType==='MISSING_RESOURCE')).toBe(true);
  expect(d.findings.find(f=>f.dependencyType==='TOOL_SCHEMA')?.line).toBe(2);
});
it('marks missing modules, omitted implementation and dynamic loads as unknown',async()=>{
  const {asset,diagnostics}=await setup({'data.py':'from .missing import tool\n# implementation omitted\ndef load(name):\n    return __import__(name)\n'});
  const d=await diagnostics.diagnose(asset);expect(d.status).toBe('PARTIAL');expect(d.dependencyStatus).toBe('UNKNOWN');
  expect(d.findings.map(f=>f.dependencyType)).toEqual(expect.arrayContaining(['MISSING_MODULE','OMITTED_IMPLEMENTATION','DYNAMIC_DEPENDENCY']));
});
it('syntax errors and unsupported code do not become dependency-free',async()=>{
  const {asset,diagnostics}=await setup({'bad.py':'def bad(', 'host.java':'class Host {}'});
  const d=await diagnostics.diagnose(asset);expect(d.dependencyStatus).toBe('UNKNOWN');expect(d.coverage.map(c=>c.status)).toEqual(expect.arrayContaining(['PARSE_FAILED','LEXICAL_ONLY']));
});
it('never executes uploaded top-level code',async()=>{
  const {asset,diagnostics}=await setup({'host.py':'raise RuntimeError("must never execute")\nprint("not executed")\n'});
  const d=await diagnostics.diagnose(asset);expect(d.scriptsExecuted).toBe(false);expect(d.findings.some(f=>f.dependencyType==='TOP_LEVEL_CALL')).toBe(true);
});
it('invalid model configuration preserves the static result and exposes retry',async()=>{
  const {asset,diagnostics}=await setup({},()=>{throw new Error('bad private configuration');});
  const d=await diagnostics.diagnose(asset);expect(d.dependencyStatus).toBe('NO_BINDING_IN_CHECKED_SCOPE');
  expect(d.ai.status).toBe('FAILED');expect(d.ai.retryable).toBe(true);expect(d.ai.error).not.toContain('bad private');
});
it('AI reads all readable code, cannot turn unsupported finding IDs into evidence, supports retry',async()=>{
  let calls=0;let body='';const {asset,diagnostics,dir}=await setup({'extra.py':'from agentscope.tool import ToolResponse\n'},()=>({configured:true,
    model:{providerId:'fixture',modelId:'fixture',parameters:{}},adapter:{adapterId:'fixture',async complete(req){calls++;body=JSON.stringify(req.messages);
      return {modelId:'fixture',content:JSON.stringify({summary:'Synthetic explanation',suggestions:[{findingId:calls===1?'made-up':'finding-1',explanation:'Import binding',nextStep:'Review adapter'}]})};}}}));
  await diagnostics.diagnose(asset);
  const get=()=>readFile(path.join(dir,'migration-diagnostics',asset.artifactSha256+'.json'),'utf8').then(JSON.parse);
  await expect.poll(async()=>(await get()).ai.status).toBe('FAILED');expect(body).toContain('extra.py');
  await diagnostics.diagnose(asset,true);await expect.poll(async()=>(await get()).ai.status).toBe('COMPLETE');expect(calls).toBe(2);
});
it('accepts only source-verifiable model Runtime bindings and feeds them into Tool classification',async()=>{
  const implementation='def indirect_tool(service, value):\n    return service.invoke(value)\n';
  const role=()=>({configured:true,model:{providerId:'fixture',modelId:'runtime-analyzer',parameters:{}},adapter:{adapterId:'fixture',async complete(){
    return {modelId:'runtime-analyzer',content:JSON.stringify({summary:'indirect runtime wrapper',suggestions:[],runtimeBindings:[
      {path:'wrapper.py',line:1,endLine:2,snippet:'def indirect_tool(service, value):\n    return service.invoke(value)',dependencyType:'RUNTIME_CONTEXT',layer:'DEPENDENCY',reason:'service is supplied by the original runtime',impact:'target runtime cannot construct this value',suggestion:'replace it with an explicit portable client',confidence:'HIGH',symbol:'indirect_tool'},
      {path:'wrapper.py',line:99,endLine:99,snippet:'invented',dependencyType:'RUNTIME_CONTEXT',layer:'DEPENDENCY',reason:'invalid',impact:'invalid',suggestion:'invalid',confidence:'LOW',symbol:'indirect_tool'}
    ]})};
  }}}) as ConfiguredModelRole;
  const {asset,diagnostics}=await setup({'SKILL.md':'---\nname: synthetic-method\ndescription: 测试间接工具。\n---\n调用 `indirect_tool`，失败时返回原因。\n','wrapper.py':implementation},role);
  const diagnosis=await diagnostics.diagnose(asset);
  expect(diagnosis.ai).toEqual(expect.objectContaining({status:'COMPLETE',acceptedRuntimeBindings:1,rejectedRuntimeBindings:1}));
  const modelFinding=diagnosis.findings.find(item=>item.source==='MODEL');
  expect(modelFinding).toEqual(expect.objectContaining({dependencyType:'RUNTIME_CONTEXT',verification:'VERIFIED',symbol:'indirect_tool'}));
  expect(new Set(diagnosis.findings.map(item=>item.id)).size).toBe(diagnosis.findings.length);
  const inspection=inspectProject({assetId:asset.assetId,assetDigest:asset.artifactSha256,
    files:{'SKILL.md':'---\nname: synthetic-method\ndescription: 测试间接工具。\n---\n调用 `indirect_tool`，失败时返回原因。\n','wrapper.py':implementation},skillFile:'SKILL.md',diagnosis});
  // Tool classification is the analysis's, not a rule's -- but the diagnostics themselves still
  // have to land on source, and their counts still reach the inspection.
  expect(inspection.tools).toEqual([]);
  expect(inspection.runtimeAnalysis).toEqual(expect.objectContaining({status:'COMPLETE',acceptedBindings:1,rejectedBindings:1}));
});
it("rejects generation before analysis without calling the Agent",async()=>{

 const f=await taskHttpFixture();const r=await f.start('generate');expect(r.statusCode).toBe(409);expect(r.body).toContain('分析');expect(f.seen).toHaveLength(0);

});
it("keeps missing source information visible and blocks generation until analysis resolves it",async()=>{

 const f=await taskHttpFixture();f.control.analysis.missing=['Missing shared contract: shared/reader.py'];
 const incomplete=await f.finish('analysis');expect(incomplete.analysis?.missing).toEqual(['Missing shared contract: shared/reader.py']);
 expect((await f.start('generate')).statusCode).toBe(409);
 f.control.analysis={...f.control.analysis,missing:[]};await f.finish('analysis');expect((await f.finish('generate')).currentCandidateId).not.toBeNull();

});
it("requires a current candidate binding when re-running analysis",async()=>{

 const f=await taskHttpFixture();const generated=await f.candidate();
 expect((await f.start('analysis',{baseCandidateId:null})).statusCode).toBe(409);
 await f.finish('analysis');expect(f.seen.at(-1)?.base.digest).toBe(generated.candidates[0]!.digest);
 expect(f.seen.at(-1)?.source.digest).toBe(generated.source.digest);

});
it("records an Agent failure without publishing an analysis or candidate",async()=>{

 const f=await taskHttpFixture();f.control.error='READ_FAILED: missing source contract';const task=await f.finish('analysis');
 expect(task.attempts.at(-1)).toMatchObject({status:'FAILED',error:expect.stringContaining('READ_FAILED')});
 expect(task.analysis).toBeUndefined();expect(task.candidates).toEqual([]);expect((await f.start('generate')).statusCode).toBe(409);

});
it("validates candidate member structure independently of Agent claims",async()=>{

 const f=await taskHttpFixture();await f.finish('analysis');f.control.files={...f.files,'skills/method/SKILL.md':encode('No frontmatter, but the Agent says this is valid.')};
 const task=await f.finish('generate');expect(task.attempts.at(-1)?.status).toBe('FAILED');expect(task.currentCandidateId).toBeNull();expect(task.candidates).toEqual([]);

});
it("makes operation keys idempotent and rejects changed content under the same key",async()=>{

 const f=await taskHttpFixture();const task=await f.finish('analysis',{key:'analysis-once'});
 const again=await f.start('analysis',{key:'analysis-once'});expect(again.statusCode).toBe(202);expect((await f.get()).attempts).toHaveLength(1);expect(f.seen).toHaveLength(1);
 expect((await f.start('generate',{key:'analysis-once'})).statusCode).toBe(409);
 expect((await f.api('POST','/api/migrations/'+task.id+'/generate',{mode:'legacy'})).statusCode).toBe(404);

});
