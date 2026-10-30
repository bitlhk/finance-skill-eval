import { taskHttpFixture, standardFiles, encode } from './task-http-fixture.js';
import { createServer } from 'node:http';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { strToU8,zipSync } from 'fflate';
import { generatePortableCandidate } from '../src/migration/infrastructure/migration-candidate-packager.js';
import { normalizeSkillPackage } from '../src/migration/infrastructure/migration-skill-normalizer.js';
import { LocalMigrationValidationRunner,pythonCommand } from '../src/migration/infrastructure/migration-technical-validator.js';
import { assessMigrationAcceptance } from '../src/migration/domain/migration-acceptance.js';
import { buildMigrationPlan } from '../src/migration/domain/migration-model.js';
import { runtimeInjection } from '../src/migration/domain/migration-runtime-rules.js';
import { analyzeSkillAndGenerateCases } from '../src/analyzer.js';
import { createEvaluationService } from '../src/service/server.js';
import { EvaluationRunManager } from '../src/service/run-manager.js';
import type { RuntimeEnvironmentDescriptor } from '../src/http-runtime.js';
import type { EnvironmentRecord } from '../src/service/contracts.js';
import type { SkillAssetRecord } from '../src/service/skill-store.js';
import type { EvaluationReport } from '../src/report.js';
import type { EvalCase } from '../src/contracts.js';
import { SKILL_MD,analysisFixture,analyzedTool,inspectionFixture,toolFixture } from './analysis-fixture.js';

const dirs:string[]=[];
afterEach(async()=>{for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});});
const asset={assetId:'source',skillId:'fixture-skill',skillFile:'skill/SKILL.md',version:'1',artifactSha256:'a'.repeat(64)} as SkillAssetRecord;
const criterion={criterionId:'actual',label:'实际核验',description:'须完成核验',dimension:'business_completeness' as const,weight:1,required:true,allOf:[],anyOf:[],noneOf:[]};
const evalCase:EvalCase={caseId:'order',name:'订单',prompt:'查询 ORDER-001',evaluationGoal:'工具核验',taskMode:'single_turn',requiredTools:['lookup','calculate'],rubric:[criterion]};

it('keeps source instructions, metadata, references and assets without editorial post-processing',()=>{
  const source=SKILL_MD+'\nStop if unapproved; do not invent an amount.\n';
  const tool=toolFixture({toolId:'lookup',name:'lookup',sourcePaths:['tool/old.py','skill/SKILL.md','skill/references/policy.md','skill/assets/orders.json']});
  const result=generatePortableCandidate({archive:{'skill/SKILL.md':strToU8(source),'tool/old.py':strToU8('legacy'),
    'skill/references/policy.md':strToU8('stop rules'),'skill/assets/orders.json':strToU8('{"ORDER-001":100}')},base:asset,inspection:inspectionFixture([tool]),
    decisions:[{toolId:'lookup',form:'SCRIPT',language:'python',baseAssetId:'source',reason:'port',decidedAt:'now'}],version:'2',
    implementations:{lookup:{language:'python',sourcePath:'lookup.py',source:'print("{}")',additionalFiles:[],dependencies:[]}}});
  expect(Buffer.from(result.files['SKILL.md']!).toString()).toContain('Stop if unapproved');
  expect(Buffer.from(result.files['SKILL.md']!).toString()).toContain('description: 夹具 Skill');
  expect(Buffer.from(result.files['references/policy.md']!).toString()).toBe('stop rules');
  expect(Buffer.from(result.files['assets/orders.json']!).toString()).toContain('ORDER-001');
});

it('keeps referenced MCP Skill guidance across regeneration and replaces its migration guide',()=>{
  const source=SKILL_MD+'\nReturn request_id, approved and reasons.\n';
  const tool=toolFixture({toolId:'lookup',name:'lookup',sourcePaths:['tools/old.py']});
  const inspection=inspectionFixture([tool]);
  const implementations={lookup:{language:'python' as const,sourcePath:'mcp-python/server.py',source:'print("server")',
    additionalFiles:[],dependencies:[],start:['uv','run','--no-project','mcp-python/server.py']}};
  const first=generatePortableCandidate({archive:{'SKILL.md':strToU8(source),'references/workflow.md':strToU8('business workflow'),
      'tools/old.py':strToU8('legacy')},base:{...asset,skillFile:'SKILL.md'},inspection,
    decisions:[{toolId:'lookup',form:'MCP',language:'python',baseAssetId:'source',reason:'port',decidedAt:'now'}],version:'2',implementations});
  expect(Buffer.from(first.files['skill/references/workflow.md']!).toString()).toBe('business workflow');
  expect(first.diff.find(item=>item.path==='skill/SKILL.md')?.before).toBe(source);

  const second=generatePortableCandidate({archive:first.files,base:{...asset,assetId:'candidate',skillFile:'skill/SKILL.md'},inspection,
    decisions:[{toolId:'lookup',form:'MCP',language:'python',baseAssetId:'candidate',reason:'port',decidedAt:'now'}],version:'3',implementations});
  const instructions=Buffer.from(second.files['skill/SKILL.md']!).toString();
  expect(Buffer.from(second.files['skill/references/workflow.md']!).toString()).toBe('business workflow');
  expect(instructions.match(/## 迁移后的执行方式/gu)).toHaveLength(1);
  expect(instructions).toContain('空数组必须保持为 `[]`');
});

it('rejects missing or empty original instructions rather than manufacturing a compliant template',()=>{
  expect(()=>normalizeSkillPackage({},'skill/SKILL.md','fixture','2')).toThrow('缺少原始');
  expect(()=>normalizeSkillPackage({'skill/SKILL.md':strToU8('---\nname: fixture\n---\n')},'skill/SKILL.md','fixture','2')).toThrow('正文为空');
});

it('fails MCP technical validation for a successful RPC carrying isError:true',async()=>{
  const server=createServer(async(req,res)=>{
    if(req.method==='DELETE'){res.end();return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);
    if(!body.id){res.writeHead(202);res.end();return;}
    const result=body.method==='initialize'?{protocolVersion:'2025-06-18',serverInfo:{name:'regression'}}:
      body.method==='tools/list'?{tools:[{name:'lookup',inputSchema:{type:'object'}}]}:{isError:true,content:[{type:'text',text:'database unavailable'}]};
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const endpoint=`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`;
    const result=await new LocalMigrationValidationRunner().validateMcp({asset,tool:toolFixture({name:'lookup',sourcePaths:['server.py']}),endpoint,arguments:{}});
    expect(result.status).toBe('FAILED');expect(result.stages.find(stage=>stage.name==='TOOLS_CALL')?.passed).toBe(false);
    expect(result.error).toContain('database unavailable');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
});

it('preserves the package Python launch spec and rejects SCRIPT/java',()=>{
  expect(pythonCommand({'scripts/tool.py':strToU8('# /// script\n# requires-python = ">=3.12"\n# ///\n')},'scripts/tool.py')).toEqual({program:'uv',args:['run','--no-project','scripts/tool.py']});
  const tool=toolFixture({toolId:'java',name:'java_tool',sourcePaths:['tool.java'],language:'Java'});
  const plan=buildMigrationPlan(inspectionFixture([tool],'source'),[{toolId:'java',form:'SCRIPT',language:'java',baseAssetId:'source',reason:'test',decidedAt:'now'}],'source');
  expect(plan.generationAllowed).toBe(false);expect(plan.items[0]?.blockingReasons.join()).toContain('不支持');
});

it('treats the Runtime workspace cwd as an implicit Script context instead of an injected value',()=>{
  const tool=toolFixture({toolId:'expense',name:'check_expense',sourcePaths:['scripts/check_expense.py'],language:'python'});
  const inspection=inspectionFixture([tool]);
  const dependency={id:'workspace',key:'expense.workspace',name:'workspace',kind:'RESOURCE',owner:'RUNTIME',action:'INJECT',contractStatus:'KNOWN',
    sensitive:false,binding:{kind:'SCRIPT_CONTEXT',name:'workspace'},toolIds:['expense'],purpose:'claim files',availability:'UNKNOWN',provided:'NONE',
    blocking:true,evidence:[],resolvedPaths:[],schema:null,schemaCompleteness:'UNKNOWN'} as const;
  inspection.dependencyAnalysis={status:'COMPLETE',revision:1,materialsDigest:'digest',dependencies:[dependency],chains:[],rejectedClaims:0};
  const plan=buildMigrationPlan(inspection,[{toolId:'expense',form:'SCRIPT',language:'python',baseAssetId:'source',reason:'cwd',decidedAt:'now'}],'source');
  expect(plan.generationAllowed).toBe(true);
  expect(runtimeInjection([dependency],{},'SCRIPT_CONTEXT').missing).toEqual([]);
});

it('binds candidate services without querying same-name external services',async()=>{
  let externalCalls=0;
  const manager=new EvaluationRunManager({environments:{async get(){externalCalls++;throw new Error('stale external service must not be used');}}} as unknown as ConstructorParameters<typeof EvaluationRunManager>[0]);
  const descriptor=await (manager as unknown as {environmentDescriptor(environment:EnvironmentRecord,required:string[],scripts:NonNullable<RuntimeEnvironmentDescriptor['commandScripts']>,services:NonNullable<RuntimeEnvironmentDescriptor['candidateMcpServices']>):Promise<RuntimeEnvironmentDescriptor>})
    .environmentDescriptor({environmentId:'runtime',mcpEnvironmentIds:['same-name-old-service']} as EnvironmentRecord,['lookup','calculate'],
      [{name:'calculate',path:'scripts/calculate.py',kind:'PYTHON',filePaths:['scripts/calculate.py'],launch:{program:'uv',args:['run','--no-project','scripts/calculate.py']}}],
      [{assetDigest:'a'.repeat(64),toolNames:['lookup'],filePaths:['mcp/server.py'],start:['uv','run','--no-project','mcp/server.py']}]);
  expect(externalCalls).toBe(0);expect(descriptor.mcpServers).toEqual([]);expect(descriptor.candidateMcpServices?.[0]?.assetDigest).toBe('a'.repeat(64));
  expect(descriptor.commandScripts?.[0]?.launch?.args).toEqual(['run','--no-project','scripts/calculate.py']);
});

function completedReport(toolCalls:Array<{name:string;status:string}>,score=4){
  const evidence={status:'completed',output:'金额 106.00',runtimeIdentityVerified:true,streamCompleted:true,toolCalls,
    metadata:{toolEvidence:toolCalls.filter(call=>call.status==='completed').map(call=>({tool:call.name,resultDigest:'digest'}))}};
  return {cases:[{caseId:'order',left:evidence,right:evidence,judgeError:null,judge:{dimensions:['professional_fit','business_completeness','clarity','actionability'].map(id=>({id,label:id,rightScore:score}))}}]} as unknown as EvaluationReport;
}

it('does not accept completed output when required tool execution failed or quality was low',()=>{
  expect(assessMigrationAcceptance(completedReport([{name:'lookup',status:'completed'},{name:'calculate',status:'failed'}]),[evalCase],true).status).toBe('FAILED');
  expect(assessMigrationAcceptance(completedReport([{name:'lookup',status:'completed'},{name:'calculate',status:'completed'}],2),[evalCase],true).status).toBe('FAILED');
  expect(assessMigrationAcceptance(completedReport([{name:'lookup',status:'completed'},{name:'calculate',status:'completed'}]),[evalCase],true).status).toBe('PASSED');
});

it('accepts an explicit stop-early scenario without requiring the forbidden calculation',()=>{
  const stop={...evalCase,toolExpectations:{mustSucceed:['lookup'],mustNotCall:['calculate']}};
  expect(assessMigrationAcceptance(completedReport([{name:'lookup',status:'completed'}]),[stop],true).status).toBe('PASSED');
  expect(assessMigrationAcceptance(completedReport([{name:'lookup',status:'completed'},{name:'calculate',status:'completed'}]),[stop],true).status).toBe('FAILED');
});

it('does not accept a partial report or missing quality dimensions',()=>{
  const report=completedReport([{name:'lookup',status:'completed'},{name:'calculate',status:'completed'}]);
  expect(assessMigrationAcceptance(report,[evalCase,{...evalCase,caseId:'missing'}],true).status).toBe('FAILED');
  report.cases[0]!.judge!.dimensions=[];
  expect(assessMigrationAcceptance(report,[evalCase],true).status).toBe('FAILED');
});

it('repairs invented fixture IDs instead of accepting a suite with no grounded sample scenario',async()=>{
  let calls=0;
  const result=await analyzeSkillAndGenerateCases({skillId:'fixture',skillSource:SKILL_MD,model:{providerId:'test',modelId:'test',parameters:{}},maximumCases:1,
    caseDesignContext:{allowedTools:['lookup'],supportedTaskModes:['single_turn'],seedTasks:[],documentedInputs:[{toolName:'lookup',input:{order_id:'ORDER-001'}}]},
    modelAdapter:{adapterId:'stub',async complete(){calls++;return {content:JSON.stringify({summary:'订单核验',cases:[{...evalCase,requiredTools:['lookup'],prompt:calls===1?'查询 ORD-2025-001':'核验 ORDER-001 金额'}]})};}}});
  expect(calls).toBe(2);expect(result.cases[0]?.prompt).toContain('ORDER-001');
});

it('drops an invented fixture case even when another case already covers the documented sample',async()=>{
  let calls=0;
  const result=await analyzeSkillAndGenerateCases({skillId:'fixture',skillSource:SKILL_MD,model:{providerId:'test',modelId:'test',parameters:{}},maximumCases:2,
    caseDesignContext:{allowedTools:['lookup'],supportedTaskModes:['single_turn'],seedTasks:[],documentedInputs:[{toolName:'lookup',input:{order_id:'ORDER-001'}}]},
    modelAdapter:{adapterId:'stub',async complete(){calls++;return {content:JSON.stringify({summary:'订单核验',cases:[
      {...evalCase,caseId:'known',requiredTools:['lookup'],prompt:'核验 ORDER-001 金额'},
      {...evalCase,caseId:'second',requiredTools:['lookup'],prompt:calls===1?'查询 INVENTED-999':'再次核验 ORDER-001 状态'},
    ]})};}}});
  expect(calls).toBe(1);expect(result.cases).toHaveLength(1);expect(result.cases.every(item=>item.prompt.includes('ORDER-001'))).toBe(true);
});

it("grounds regeneration on immutable source and current candidate without exposing holdout cases",async()=>{

 const f=await taskHttpFixture();await f.ready();const original=(await f.get()).source.digest;
 f.control.files={...f.files,'shared/rules.json':encode('{"limit":200}')};const task=await f.finish('generate');
 await f.finish('analysis');expect(f.seen.at(-1)?.source.digest).toBe(original);expect(f.seen.at(-1)?.base.digest).toBe(task.candidates.at(-1)?.digest);
 expect(JSON.stringify(f.seen)).not.toContain('HOLDOUT_SECRET');expect(JSON.stringify(f.seen)).not.toContain('HOLDOUT_CRITERION');

});
