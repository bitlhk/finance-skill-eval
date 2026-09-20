import { createServer } from 'node:http';
import { mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { strToU8,zipSync } from 'fflate';
import { generatePortableCandidate } from '../src/service/portable-candidate.js';
import { normalizeSkillPackage } from '../src/service/skill-normalizer.js';
import { TechnicalValidationService,pythonCommand } from '../src/service/technical-validation.js';
import { assessMigrationAcceptance } from '../src/service/migration-acceptance.js';
import { buildMigrationPlan } from '../src/service/migration-model.js';
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

it('keeps source instructions, metadata, references and data even when A2 cites them as tool sourcePaths',()=>{
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
    const result=await new TechnicalValidationService().validateMcp({asset,tool:toolFixture({name:'lookup',sourcePaths:['server.py']}),endpoint,arguments:{}});
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

it('grounds questions on frozen source analysis and skill-relative references after candidate inspection changes',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'migration-grounding-'));dirs.push(directory);
  let grounding='',tools:string[]=[];
  const app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:directory,accessToken:'test',publicDemo:false,
    migrationAnalyzer:analysisFixture([analyzedTool({name:'lookup',sample:{account_id:'A-1'}})]),
    migrationSuite:async input=>{grounding=input.skillSource;tools=input.tools;return {summary:'source',cases:[{...evalCase,requiredTools:['lookup']}]};}});
  const headers={authorization:'Bearer test'},post=(url:string,payload:unknown={})=>app.inject({method:'POST',url,headers,payload});
  try{
    const source=(await app.inject({method:'POST',url:'/api/migrations/upload',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync({'skill/SKILL.md':strToU8(SKILL_MD),'tool/lookup.py':strToU8('def lookup(): pass'),'skill/references/policy.md':strToU8('POLICY_FROM_SOURCE')}))})).json();
    const project=(await post('/api/migrations',{sourceAssetId:source.assetId,name:'grounding'})).json();
    expect((await post(`/api/migrations/${project.id}/inspect`)).statusCode).toBe(200);
    const recordPath=path.join(directory,'migrations',`${project.id}.json`),record=JSON.parse(await readFile(recordPath,'utf8'));
    // Mimic candidate re-analysis replacing the current surface without altering source grounding.
    record.inspection.tools[0].inputSchema={candidate_only:true};record.inspection.tools[0].samples=[];
    await writeFile(recordPath,JSON.stringify(record));
    const response=await post(`/api/migrations/${project.id}/suites/generated`,{baseAssetId:source.assetId});
    expect(response.statusCode).toBe(200);expect(grounding).toContain('POLICY_FROM_SOURCE');expect(grounding).toContain('A-1');expect(grounding).not.toContain('candidate_only');expect(tools).toEqual(['lookup']);
  }finally{await app.close();}
});
