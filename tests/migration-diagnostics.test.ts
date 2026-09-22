import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, it, expect } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { SkillStore } from '../src/service/skill-store.js';
import { MigrationDiagnostics } from '../src/service/migration-diagnostics.js';
import { inspectProject } from '../src/service/tool-inspector.js';
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
it('fails closed with a clear conflict when no analysis is available',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'migration-missing-scanner-')),data=path.join(root,'data');dirs.push(root);
  await mkdir(path.join(root,'packs','finance'),{recursive:true});
  await writeFile(path.join(root,'packs','finance','catalog.yaml'),'schemaVersion: finance.skill-catalog.v1\nskills:\n  - skillId: fixture\n    displayName: Fixture\n    roleName: Tester\n    category: Test\n    iconKey: audit\n    featuredOrder: 0\n    summary: Test fixture\n    capabilities: [Test]\n');
  const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,accessToken:'test',publicDemo:false});
  const headers={authorization:'Bearer test'};
  try{
    const zip=Buffer.from(zipSync({'SKILL.md':strToU8(method)}));
    const asset=(await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:zip})).json();
    const project=(await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:asset.assetId,name:'missing scanner'}})).json();
    const result=await app.inject({method:'POST',url:`/api/migrations/${project.id}/inspect`,headers,payload:{}});
    expect(result.statusCode).toBe(409);expect(result.json().message).toContain('分析不可用');
  }finally{await app.close();}
});
it('reports what the analysis agent could not read, instead of calling it unavailable',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'migration-abstained-')),data=path.join(root,'data');dirs.push(root);
  await mkdir(path.join(root,'packs','finance'),{recursive:true});
  await writeFile(path.join(root,'packs','finance','catalog.yaml'),'schemaVersion: finance.skill-catalog.v1\nskills:\n  - skillId: fixture\n    displayName: Fixture\n    roleName: Tester\n    category: Test\n    iconKey: audit\n    featuredOrder: 0\n    summary: Test fixture\n    capabilities: [Test]\n');
  // An abstention is a judgement: the agent knows why it stopped. Collapsing it into "no analysis"
  // throws that away and leaves the reader with nothing to act on.
  const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,accessToken:'test',publicDemo:false,
    migrationAnalyzer:async()=>({status:'ABSTAINED' as const,reason:'工具实现是编译产物，读不到源码',missing:['tool/orders/impl.jar']})});
  const headers={authorization:'Bearer test'};
  try{
    const zip=Buffer.from(zipSync({'SKILL.md':strToU8(method)}));
    const asset=(await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:zip})).json();
    const project=(await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:asset.assetId,name:'abstained'}})).json();
    const result=await app.inject({method:'POST',url:`/api/migrations/${project.id}/inspect`,headers,payload:{}});
    expect(result.statusCode).toBe(409);
    expect(result.json().message).toContain('工具实现是编译产物，读不到源码');
    expect(result.json().message).toContain('tool/orders/impl.jar');
    expect(result.json().message).not.toContain('分析不可用');
  }finally{await app.close();}
});
it('re-runs the analysis when the recorded product no longer matches its binding',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-binding-'));dirs.push(data);
  let calls=0;
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false,
    migrationAnalyzer:async input=>{calls+=1;return {status:'PRODUCED' as const,
      payload:{status:'PRODUCED',skill:{status:'COMPLIANT',findings:[]},tools:[{name:'lookup',sourcePaths:['tool/lookup.py'],language:'Python',portability:'RUNTIME_BOUND',
        input:{description:'',schema:null,path:'skill/SKILL.md',line:3},output:{description:'',schema:null,path:'skill/SKILL.md',line:3},
        evidence:[],findings:[],recommendedForm:'SCRIPT',recommendationReason:'夹具'}]},
      scanner:{scannerDigest:'a'.repeat(64),coverage:[]}};}});
  const headers={authorization:'Bearer test'};
  try{
    const zip=Buffer.from(zipSync({'skill/SKILL.md':strToU8(method),'tool/lookup.py':strToU8('def lookup(value): return value\n')}));
    const asset=(await app.inject({method:'POST',url:'/api/migrations/upload',headers:{...headers,'content-type':'application/zip'},payload:zip})).json();
    const project=(await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:asset.assetId,name:'binding'}})).json();
    await app.inject({method:'POST',url:`/api/migrations/${project.id}/inspect`,headers,payload:{}});
    expect(calls).toBe(1);
    // Same asset, so the recorded product still describes it.
    await app.inject({url:`/api/migrations/${project.id}/inspection`,headers});
    expect(calls).toBe(1);
    // A record whose product was written for other contents -- what an upgrade can leave behind.
    const file=path.join(data,'migrations',`${project.id}.json`),record=JSON.parse(await readFile(file,'utf8'));
    record.analysis.binding.assetDigest='0'.repeat(64);
    await writeFile(file,JSON.stringify(record,null,2));
    await app.inject({url:`/api/migrations/${project.id}/inspection`,headers});
    expect(calls).toBe(2);
  }finally{await app.close();}
});
it('reports why the analysis agent did not finish, instead of calling it unavailable',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'migration-agent-failed-')),data=path.join(root,'data');dirs.push(root);
  await mkdir(path.join(root,'packs','finance'),{recursive:true});
  await writeFile(path.join(root,'packs','finance','catalog.yaml'),'schemaVersion: finance.skill-catalog.v1\nskills:\n  - skillId: fixture\n    displayName: Fixture\n    roleName: Tester\n    category: Test\n    iconKey: audit\n    featuredOrder: 0\n    summary: Test fixture\n    capabilities: [Test]\n');
  // A run that did not finish is an execution problem, and the reader needs to know that rather
  // than be told, uselessly, that there is no analysis.
  const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,accessToken:'test',publicDemo:false,
    migrationAnalyzer:async()=>({status:'FAILED' as const,reason:'agent produced no result line: model call failed'})});
  const headers={authorization:'Bearer test'};
  try{
    const zip=Buffer.from(zipSync({'SKILL.md':strToU8(method)}));
    const asset=(await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:zip})).json();
    const project=(await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:asset.assetId,name:'agent failed'}})).json();
    const result=await app.inject({method:'POST',url:`/api/migrations/${project.id}/inspect`,headers,payload:{}});
    expect(result.statusCode).toBe(409);
    expect(result.json().message).toContain('model call failed');
    expect(result.json().message).toContain('执行问题');
    expect(result.json().message).not.toContain('分析不可用');
  }finally{await app.close();}
});
it('takes the Skill verdict from the rules, not from the model that judges it twice',async()=>{
  const data=await mkdtemp(path.join(os.tmpdir(),'migration-verdict-'));dirs.push(data);
  const tool={name:'lookup',sourcePaths:['tool/lookup.py'],language:'Python',portability:'RUNTIME_BOUND',
    input:{description:'',schema:null,path:'skill/SKILL.md',line:1},output:{description:'',schema:null,path:'skill/SKILL.md',line:1},
    evidence:[],findings:[],recommendedForm:'SCRIPT',recommendationReason:'夹具'};
  // The same package, and the agent calls it compliant. Asked again it will call it non-compliant:
  // a verdict that flips is not a verdict, so the platform's own rules decide.
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:data,accessToken:'test',publicDemo:false,
    migrationAnalyzer:async()=>({status:'PRODUCED' as const,
      payload:{status:'PRODUCED',skill:{status:'NON_COMPLIANT',findings:[]},tools:[tool]},
      scanner:{scannerDigest:'a'.repeat(64),coverage:[]}})});
  const headers={authorization:'Bearer test'};
  try{
    // `method` carries no description, and the rules count that as an error -- so a compliant Skill
    // is what shows the agent being overruled in the permissive direction.
    const compliant='---\nname: verdict-fixture\ndescription: 用来验证合规判定的归属。\n---\n调用 `lookup`，失败时说明原因。';
    const zip=Buffer.from(zipSync({'skill/SKILL.md':strToU8(compliant),'tool/lookup.py':strToU8('def lookup(value): return value\n')}));
    const asset=(await app.inject({method:'POST',url:'/api/migrations/upload',headers:{...headers,'content-type':'application/zip'},payload:zip})).json();
    const project=(await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:asset.assetId,name:'verdict'}})).json();
    const inspection=(await app.inject({method:'POST',url:`/api/migrations/${project.id}/inspect`,headers,payload:{}})).json();
    expect(inspection.skill.status).toBe('COMPLIANT');

    // And the rules can veto the model the other way: a Skill with no description is an error
    // whatever the agent thought of it.
    const invalid=(await app.inject({method:'POST',url:'/api/migrations/upload',headers:{...headers,'content-type':'application/zip'},
      payload:Buffer.from(zipSync({'skill/SKILL.md':strToU8('---\nname: no-description\n---\n调用 `lookup`。'),'tool/lookup.py':strToU8('def lookup(value): return value\n')}))})).json();
    const second=(await app.inject({method:'POST',url:'/api/migrations',headers,payload:{sourceAssetId:invalid.assetId,name:'verdict-2'}})).json();
    const checked=(await app.inject({method:'POST',url:`/api/migrations/${second.id}/inspect`,headers,payload:{}})).json();
    expect(checked.skill.status).toBe('NON_COMPLIANT');
    expect(checked.skill.findings.map((f:{code:string})=>f.code)).toContain('DESCRIPTION_REQUIRED');
  }finally{await app.close();}
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
