import {afterEach,it,expect,vi} from 'vitest';
import {strToU8} from 'fflate';
import {runtimeToolConfigTemplate,validateAgentRuntimeDelivery} from '../src/service/migration-delivery-contract.js';
import {inspectionFixture,toolFixture,SKILL_MD} from './analysis-fixture.js';
import {analyzeDependencies} from '../src/service/migration-dependencies.js';
import {generatePortableCandidate} from '../src/service/portable-candidate.js';
import {LocalWorker} from '../src/service/local-worker.js';
import {toGeneratedImplementations,toSkillDocumentDelivery} from '../src/service/migration-agent.js';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {GenerationStatus,generatedCallState} from '../web/src/GenerationStatus.js';

afterEach(()=>vi.unstubAllEnvs());

function fixture(){
 const tool=toolFixture({name:'balance',sourcePaths:['balance.mjs'],language:'Node'}),inspection=inspectionFixture([tool]);
 const ref={toolName:'balance',path:'balance.mjs',snippet:'query(account, credential)'};
 inspection.dependencyAnalysis=analyzeDependencies({dependencyAnalysis:{dependencies:[{key:'credential',name:'Credential',kind:'DATA',owner:'RUNTIME',action:'INJECT',contractStatus:'KNOWN',sensitive:true,blocking:true,purpose:'余额接口凭证',availability:'MISSING',references:[ref],binding:{kind:'HTTP_HEADER',name:'Authorization'},schema:{type:'string'},schemaCompleteness:'COMPLETE',schemaEvidence:[{path:'balance.mjs',snippet:'/** @type {string} */'}]}],chains:[{toolName:'balance',nodes:[{id:'call',title:'余额',detail:'业务请求',dependencyKeys:['credential'],evidence:[ref]}],edges:[]}]}},inspection,{'balance.mjs':'/** @type {string} */ const credential = runtime.credential; query(account, credential);'},[],0,'digest');
 const decisions=[{toolId:tool.toolId,form:'MCP' as const,language:'node',reason:'',baseAssetId:'asset',decidedAt:'now'}];
 return {tool,inspection,decisions};
}

it('builds a loadable environment-backed template without actual values or SDK code',()=>{
 const {inspection,decisions,tool}=fixture(),template=runtimeToolConfigTemplate(inspection,decisions);
 expect(template.requiredEnvironment).toHaveLength(1);expect(template.unresolved).toEqual([]);
 const context=Object.values(template.runtimeToolConfig.context)[0]!;
 expect(context.type).toBe('string');expect(context.env).toBeTruthy();expect(context).not.toHaveProperty('value');
 expect(template.runtimeToolConfig.tools.balance!.contextBindings.Authorization).toMatch(/^context\./);
 const payload={tools:[{toolId:tool.toolId,compilePassed:true,contractPassed:true,runtimeBindings:[{key:'credential',header:'Authorization'}]}],runtimeToolConfig:template.runtimeToolConfig};
 expect(validateAgentRuntimeDelivery(payload,inspection,decisions)).toEqual([]);
 expect(validateAgentRuntimeDelivery({...payload,runtimeToolConfig:{schemaVersion:'finance.runtime-tool-config-template.v1',runtimeToolConfig:template.runtimeToolConfig}},inspection,decisions)).toEqual([]);
 expect(validateAgentRuntimeDelivery({...payload,runtimeToolConfig:{schemaVersion:'wrong',runtimeToolConfig:template.runtimeToolConfig}},inspection,decisions).join()).toContain('不一致');
 expect(validateAgentRuntimeDelivery({...payload,runtimeToolConfig:{context:{},tools:{},providers:{}}},inspection,decisions).join()).toContain('不一致');
 payload.tools[0]!.runtimeBindings[0]!.header='X-Wrong';expect(validateAgentRuntimeDelivery(payload,inspection,decisions).join()).toContain('Header 绑定');
});

it('reports unknown consumption types rather than inventing Credential structure',()=>{
 const {inspection,decisions}=fixture();inspection.dependencyAnalysis!.dependencies[0]!.schema=null;
 const template=runtimeToolConfigTemplate(inspection,decisions);expect(template.unresolved).toHaveLength(1);expect(template.runtimeToolConfig.context).toEqual({});
});

it('retains pending-call evidence through delivery and renders it without a business pass claim',()=>{
 const {inspection,decisions,tool}=fixture();
 const mapped=toGeneratedImplementations({tools:[{toolId:tool.toolId,language:'node',entrypoint:'mcp/server.mjs',files:['mcp/server.mjs'],compilePassed:true,contractPassed:true,callExecuted:false,runtimeDependenciesPending:['Credential'],runtimeBindings:[{key:'credential',header:'Authorization'}],start:['node','mcp/server.mjs']}]},{'mcp/server.mjs':Buffer.from('// server').toString('base64')},{[tool.toolId]:'balance'});
 const candidate=generatePortableCandidate({archive:{'SKILL.md':strToU8(SKILL_MD)},base:{skillFile:'SKILL.md',skillId:'test'} as any,inspection,decisions,version:'2.0.0',implementations:mapped});
 const generation=candidate.generations[0]!;
 expect(generation.callExecuted).toBe(false);expect(generation.runtimeDependenciesPending).toEqual(['Credential']);
 const html=renderToStaticMarkup(createElement(GenerationStatus,{generation,configure:()=>{}}));
 expect(html).toContain('业务调用待验证');expect(html).toContain('测试所需依赖：Credential');expect(html).toContain('配置并试运行');expect(html).not.toContain('业务调用已通过');
 expect(renderToStaticMarkup(createElement(GenerationStatus,{generation,latest:{status:'PASSED'}}))).toContain('业务调用已通过');
 expect(renderToStaticMarkup(createElement(GenerationStatus,{generation,latest:{status:'FAILED'}}))).toContain('最近一次业务调用失败');
 expect(generatedCallState({toolId:'legacy',readyForValidation:true,checks:[{name:'JSON_SMOKE',passed:true,message:'契约测试通过'}]})).toBe('UNKNOWN');
 expect(generatedCallState({toolId:'legacy',readyForValidation:true,checks:[{name:'JSON_SMOKE',passed:true,message:'实际调用尚未执行'}]})).toBe('PENDING');
});

it('accepts workspace cwd as implicit Script context at delivery validation',()=>{
 const tool=toolFixture({name:'expense',sourcePaths:['scripts/expense.py'],language:'Python'}),inspection=inspectionFixture([tool]);
 inspection.dependencyAnalysis={dependencies:[{key:'workspace',name:'workspace',owner:'RUNTIME',action:'INJECT',sensitive:false,toolIds:[tool.toolId],binding:{kind:'SCRIPT_CONTEXT',name:'workspace'}}]} as any;
 const decisions=[{toolId:tool.toolId,form:'SCRIPT' as const,language:'python',reason:'',baseAssetId:'asset',decidedAt:'now'}];
 const payload={tools:[{toolId:tool.toolId,compilePassed:true,contractPassed:true,callExecuted:true,runtimeBindings:[]}]};
 expect(validateAgentRuntimeDelivery(payload,inspection,decisions)).toEqual([]);
 payload.tools[0]!.runtimeBindings=[{key:'workspace',header:'X-Workspace'}];
 expect(validateAgentRuntimeDelivery(payload,inspection,decisions).join()).toContain('Script 不支持 Runtime 注入');
});

it('excludes runtime workspace data from the delivered Skill package',()=>{
 const tool=toolFixture({name:'expense',sourcePaths:['scripts/expense.py'],language:'Python'}),inspection=inspectionFixture([tool]);
 const archive=Object.fromEntries(Object.entries({'SKILL.md':SKILL_MD,'workspace/EXP-001.json':'{"id":"EXP-001"}','references/workspace/EXP-002.json':'{"id":"EXP-002"}','scripts/expense.py':'print("{}")'}).map(([name,value])=>[name,strToU8(value)]));
 const result=generatePortableCandidate({archive,base:{skillFile:'SKILL.md',skillId:'test'} as any,inspection,decisions:[{toolId:tool.toolId,form:'SCRIPT',language:'python'}] as any,version:'2.0.0',implementations:{[tool.toolId]:{language:'python',sourcePath:'scripts/expense.py',source:'print("{}")',additionalFiles:[],dependencies:[]}} as any});
 expect(Object.keys(result.files).some(name=>name.startsWith('workspace/')||name.startsWith('references/workspace/'))).toBe(false);
});

it('does not rewrite short references after generation',()=>{
 const tool=toolFixture({name:'expense',sourcePaths:['scripts/expense.py'],language:'Python'}),inspection=inspectionFixture([tool]);
 const archive=Object.fromEntries(Object.entries({'SKILL.md':SKILL_MD+'\n请阅读 `references/workflow.md`。','references/workflow.md':'# 处理流程\n\n先核对，再返回。','scripts/expense.py':'print("{}")'}).map(([name,value])=>[name,strToU8(value)]));
 const result=generatePortableCandidate({archive,base:{skillFile:'SKILL.md',skillId:'test'} as any,inspection,decisions:[{toolId:tool.toolId,form:'SCRIPT',language:'python'}] as any,version:'2.0.0',implementations:{[tool.toolId]:{language:'python',sourcePath:'scripts/expense.py',source:'print("{}")',additionalFiles:[],dependencies:[]}} as any});
 expect(Buffer.from(result.files['references/workflow.md']!).toString()).toContain('先核对，再返回。');
 expect(Buffer.from(result.files['SKILL.md']!).toString()).toContain('references/workflow.md');
});

it('does not use document length as a packaging rewrite threshold',()=>{
 const tool=toolFixture({name:'expense',sourcePaths:['scripts/expense.py'],language:'Python'}),inspection=inspectionFixture([tool]);
 const longReference=['# 大型手册',...Array.from({length:500},(_,index)=>`规则 ${index+1}`)].join('\n');
 const archive=Object.fromEntries(Object.entries({'SKILL.md':SKILL_MD+'\n请阅读 `references/manual.md`。','references/manual.md':longReference,'scripts/expense.py':'print("{}")'}).map(([name,value])=>[name,strToU8(value)]));
 const result=generatePortableCandidate({archive,base:{skillFile:'SKILL.md',skillId:'test'} as any,inspection,decisions:[{toolId:tool.toolId,form:'SCRIPT',language:'python'}] as any,version:'2.0.0',implementations:{[tool.toolId]:{language:'python',sourcePath:'scripts/expense.py',source:'print("{}")',additionalFiles:[],dependencies:[]}} as any});
 expect(result.files['references/manual.md']).toBeDefined();expect(Buffer.from(result.files['SKILL.md']!).toString()).toContain('references/manual.md');
});

it('uses the A4 document manifest without post-processing its references',()=>{
 const encoded=(value:string)=>Buffer.from(value).toString('base64');
 const delivery=toSkillDocumentDelivery({skillDelivery:{skillFile:'SKILL.md',files:[
  {source:'migration-skill/SKILL.md',path:'SKILL.md'},
  {source:'migration-skill/references/policy.md',path:'references/policy.md'},
 ]}},{'migration-skill/SKILL.md':encoded(SKILL_MD+'\n读取 `references/policy.md`。'),'migration-skill/references/policy.md':encoded('短但独立的政策。')});
 expect(delivery).not.toBeNull();
 const tool=toolFixture({name:'expense',sourcePaths:['scripts/expense.py'],language:'Python'}),inspection=inspectionFixture([tool]);
 const result=generatePortableCandidate({archive:{'SKILL.md':strToU8(SKILL_MD),'references/old.md':strToU8('old')},base:{skillFile:'SKILL.md',skillId:'test'} as any,inspection,decisions:[],version:'2.0.0',skillDelivery:delivery!});
 expect(Buffer.from(result.files['references/policy.md']!).toString()).toBe('短但独立的政策。');
 expect(result.files['references/old.md']).toBeUndefined();
 expect(Buffer.from(result.files['SKILL.md']!).toString()).toContain('references/policy.md');
});

it('resolves a Java service directory entrypoint only from its declared main class',()=>{
 const encoded=(value:string)=>Buffer.from(value).toString('base64');
 const files={'mcp-java/src/com/acme/Main.java':encoded('package com.acme; class Main {}'),'mcp-java/src/com/acme/Helper.java':encoded('package com.acme; class Helper {}')};
 const mapped=toGeneratedImplementations({tools:[{toolId:'java-tool',language:'java',entrypoint:'mcp-java',files:Object.keys(files),start:['java','-cp','mcp-java/src','com.acme.Main'],compilePassed:true,contractPassed:true}]},files,{'java-tool':'lookup'});
 expect(mapped['java-tool']?.sourcePath).toBe('mcp-java/src/com/acme/Main.java');
 expect(mapped['java-tool']?.additionalFiles.map(file=>file.path)).toEqual(['mcp-java/src/com/acme/Helper.java']);
 expect(mapped['java-tool']?.prepare).toEqual(['javac','--release','17','-encoding','UTF-8','mcp-java/src/com/acme/Main.java','mcp-java/src/com/acme/Helper.java']);
});

it('packages matching Skill execution instructions and MCP configuration',()=>{
 const {inspection,decisions,tool}=fixture();
 const generated=generatePortableCandidate({archive:{'SKILL.md':strToU8(SKILL_MD),'balance.mjs':strToU8('old')},base:{skillFile:'SKILL.md',skillId:'test'} as any,inspection,decisions,version:'2.0.0',implementations:{[tool.toolId]:{language:'node',sourcePath:'mcp/server.mjs',source:'// server',additionalFiles:[],dependencies:[],smokeInput:{},generatedBy:'A4',explanation:'',attempts:1,checks:[],start:['node','mcp/server.mjs']}}});
 const instructions=Buffer.from(generated.files['skill/SKILL.md']!).toString();expect(instructions).toContain('通过 MCP 调用同名工具');expect(instructions).toContain('runtime-tool-config.template.json');
 const config=JSON.parse(Buffer.from(generated.files['runtime-tool-config.template.json']!).toString());expect(config.runtimeToolConfig.tools.balance).toBeDefined();expect(config.requiredEnvironment).toHaveLength(1);
 expect(generated.files['mcp/runtime-tool-config.template.json']).toBeUndefined();
});

it('does not retain an empty scripts tree after a tool is replaced by MCP',()=>{
 const {inspection,decisions,tool}=fixture();
 tool.sourcePaths=['tools/balance.py','tools/http_client.py'];
 const generated=generatePortableCandidate({archive:{'SKILL.md':strToU8(SKILL_MD),'tools/__init__.py':strToU8(''),'tools/balance.py':strToU8('old'),'tools/http_client.py':strToU8('old')},base:{skillFile:'SKILL.md',skillId:'test'} as any,inspection,decisions,version:'2.0.0',implementations:{[tool.toolId]:{language:'node',sourcePath:'mcp-node/server.mjs',source:'// server',additionalFiles:[],dependencies:[],smokeInput:{},generatedBy:'A4',explanation:'',attempts:1,checks:[],start:['node','mcp-node/server.mjs']}}});
 expect(Object.keys(generated.files).some(name=>name.startsWith('skill/scripts/'))).toBe(false);
});

it('technical Script execution uses separate cwd and absolute entry/resource paths',async()=>{
 vi.stubEnv('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS','1');
 const source="import fs from 'node:fs';import path from 'node:path';const resource=fs.readFileSync(new URL('./resource.txt',import.meta.url),'utf8');if(path.dirname(new URL(import.meta.url).pathname).includes(process.cwd()))throw Error('cwd is package');fs.writeFileSync('result.txt',resource);console.log(JSON.stringify({resource,cwd:process.cwd()}));";
 const worker=new LocalWorker();const result=await worker.run({requestId:'separate',program:'node',args:['entry.mjs'],separateWorkspace:true,files:[{path:'entry.mjs',content:strToU8(source)},{path:'resource.txt',content:strToU8('package-data')}],stdin:'{}'});
 expect(result.exitCode,result.stderr).toBe(0);expect(JSON.parse(result.stdout).resource).toBe('package-data');expect(JSON.parse(result.stdout).cwd).toContain('finance-migration-execution-');
});

it('seeds declared sample workspace files without running inside the Skill package',async()=>{
 vi.stubEnv('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS','1');
 const source="import fs from 'node:fs';console.log(JSON.stringify({value:fs.readFileSync('EXP-001.json','utf8'),cwd:process.cwd()}));";
 const worker=new LocalWorker();const result=await worker.run({requestId:'workspace-fixture',program:'node',args:['entry.mjs'],separateWorkspace:true,files:[{path:'entry.mjs',content:strToU8(source)}],workspaceFiles:[{path:'EXP-001.json',content:strToU8('sample-claim')}],stdin:'{}'});
 expect(result.exitCode,result.stderr).toBe(0);expect(JSON.parse(result.stdout).value).toBe('sample-claim');expect(JSON.parse(result.stdout).cwd).toContain('finance-migration-execution-');
});

it('preserves an A4 Script layout that was already contract-tested',()=>{
 const tool=toolFixture({name:'expense',sourcePaths:['scripts/legacy.py'],language:'Python'}),inspection=inspectionFixture([tool]);
 const result=generatePortableCandidate({archive:{'SKILL.md':strToU8(SKILL_MD),'assets/rules.json':strToU8('{}')},base:{skillFile:'SKILL.md',skillId:'test'} as any,inspection,decisions:[{toolId:tool.toolId,form:'SCRIPT',language:'python'}] as any,version:'2.0.0',implementations:{[tool.toolId]:{language:'python',sourcePath:'scripts/check_expense.py',source:'from pathlib import Path\nRULES=Path(__file__).resolve().parents[1]/"assets"/"rules.json"',additionalFiles:[{path:'scripts/README.md',content:'docs'}],dependencies:[],generatedBy:'expense',explanation:'',attempts:1,checks:[]}} as any});
 expect(result.generations[0]!.entrypoint).toBe('scripts/check_expense.py');
 expect(result.files['scripts/check_expense.py']).toBeDefined();
 expect(result.files['scripts/expense/check_expense.py']).toBeUndefined();
});

it('relocates multi-file scripts with their resources and documentation, retiring exclusive Runtime code',()=>{
 const tool=toolFixture({name:'quote_fee',sourcePaths:['scripts/quote_fee.py'],language:'Python'}),inspection=inspectionFixture([tool]);
 inspection.dependencyAnalysis={dependencies:[
  {owner:'TOOL',action:'KEEP',toolIds:[tool.toolId],resolvedPaths:['scripts/rates.json']},
  {owner:'RUNTIME',action:'MOVE_TO_RUNTIME',toolIds:[tool.toolId],resolvedPaths:['tools/legacy_runtime.py']},
 ]} as any;
 const archive=Object.fromEntries(Object.entries({'SKILL.md':SKILL_MD+'\nRun `scripts/quote_fee.py`, using `scripts/rates.json`.','scripts/quote_fee.py':'old','scripts/rates.json':'{"rate":0.025}','tools/legacy_runtime.py':'old runtime'}).map(([name,text])=>[name,strToU8(text)]));
 const implementation={language:'python',sourcePath:'scripts/quote_fee.py',source:'print(1)',additionalFiles:[{path:'scripts/rates.json',content:'{"rate":0.025}'},{path:'scripts/README.md',content:'python scripts/quote_fee.py'}],dependencies:[]};
 const input={archive,base:{skillFile:'SKILL.md',skillId:'test'} as any,inspection,decisions:[{toolId:tool.toolId,form:'SCRIPT',language:'python'}] as any,version:'2.0.0',implementations:{[tool.toolId]:implementation} as any};
 const result=generatePortableCandidate(input);
 expect(result.generations[0]!.entrypoint).toBe('scripts/quote_fee/quote_fee.py');
 expect(result.files['scripts/quote_fee/rates.json']).toBeDefined();expect(result.files['scripts/rates.json']).toBeUndefined();
 expect(Object.keys(result.files).some(name=>name.endsWith('legacy_runtime.py'))).toBe(false);
 expect(Buffer.from(result.files['scripts/quote_fee/README.md']!).toString()).toContain('python quote_fee.py');
 expect(Buffer.from(result.files['SKILL.md']!).toString()).toContain('`scripts/quote_fee/quote_fee.py`');
 // Dependencies still consumed by an unmigrated tool must remain in the source package.
 const other=toolFixture({name:'other',sourcePaths:['other.py'],language:'Python'});inspection.tools.push(other);
 inspection.dependencyAnalysis!.dependencies.forEach(dep=>dep.toolIds.push(other.toolId));
 const shared=generatePortableCandidate(input);expect(shared.files['scripts/rates.json']).toBeDefined();expect(shared.files['scripts/tools/legacy_runtime.py']).toBeDefined();
});
