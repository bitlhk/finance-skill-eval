import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { SkillStore } from '../src/service/skill-store.js';
import { MigrationDiagnostics } from '../src/service/migration-diagnostics.js';
import { createEvaluationService } from '../src/service/server.js';
import type { ConfiguredModelRole } from '../src/service/config.js';

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
it('project creation is idempotent, generates actual adapters and invalidates stale edits',async()=>{
  const {asset,dir}=await setup({'helper.py':'from agentscope.tool import ToolResponse\n'});
  const app=await createEvaluationService({dataDirectory:dir,rootDirectory:path.resolve('.'),accessToken:'test'});
  const headers={authorization:'Bearer test'};
  const post=(url:string,payload:unknown)=>app.inject({url,method:'POST',headers,payload});
  try{
    const input={sourceAssetId:asset.assetId,name:'Synthetic'};
    const first=(await post('/api/migrations',input)).json(),second=(await post('/api/migrations',input)).json();expect(first.id).toBe(second.id);
    const diagnostic=await app.inject({url:`/api/migrations/${first.id}/diagnosis`,headers});expect(diagnostic.json().findings.length).toBeGreaterThan(0);
    const bad=await post(`/api/migrations/${first.id}/generate`,{runtime:'openjiuwen',environmentId:'env-missing',intent:'portable_method_and_adapters',baseAssetId:asset.assetId});expect(bad.statusCode).toBe(409);
    const result=await post(`/api/migrations/${first.id}/generate`,{runtime:'openjiuwen',intent:'portable_method_and_adapters',baseAssetId:asset.assetId});expect(result.statusCode).toBe(200);
    const candidate=result.json();expect(candidate.source).toEqual(asset);
    expect(candidate.generation.diff.map((d:{path:string})=>d.path)).toContain('migration-generated/OpenJiuwenMigrationTool.java');
    const edit=await post(`/api/migrations/${first.id}/drafts`,{source:method+'Keep sources.',notes:'Add output requirement',autoVersion:true,baseAssetId:candidate.candidate.assetId});expect(edit.statusCode).toBe(200);
    expect((await post(`/api/migrations/${first.id}/drafts`,{source:method,notes:'Stale',autoVersion:true,baseAssetId:candidate.candidate.assetId})).statusCode).toBe(409);
    const report=(await app.inject({url:`/api/migrations/${first.id}/report`,headers})).json();expect(report.verification.candidateChanged).toBe(true);
    expect(report.verification.targetExecution).toBe('NOT_RUN');
    expect((await post(`/api/migrations/${first.id}/optimize`,{jobId:'fake'})).statusCode).toBe(409);
    expect((await post(`/api/migrations/${first.id}/releases`,{})).statusCode).toBe(409);
  }finally{await app.close();}
});
