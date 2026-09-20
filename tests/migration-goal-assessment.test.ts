import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {strToU8,zipSync} from 'fflate';
import {simpleMigrationSuiteSchema,simpleMigrationCases,simpleMigrationSuiteExample} from '../src/service/simple-migration-suite.js';
import {ModelGoalJudge} from '../src/goal-judge.js';
import {runtimeExecutionEvidenceSchema} from '../src/contracts.js';
import {assessMigrationAcceptance} from '../src/service/migration-acceptance.js';
import {createEvaluationService} from '../src/service/server.js';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {MigrationAssessmentStep} from '../web/src/MigrationAssessmentStep.js';
import {EvaluationRunManager} from '../src/service/run-manager.js';
const model={providerId:'test',modelId:'test',parameters:{}};
const evidence=runtimeExecutionEvidenceSchema.parse({runId:'test',side:'right',caseId:'fee-001',status:'completed',modelId:'test',skillVersion:'1.0.0',output:'服务费为人民币 2.50 元，尚未扣费。',elapsedMs:1,runtimeIdentityVerified:true,streamCompleted:true,error:null});
const definition=simpleMigrationCases(simpleMigrationSuiteSchema.parse({name:'test',cases:[{id:'fee-001',input:'计算服务费',criteria:['服务费为2.5元','说明尚未扣费']}]}))[0]!;
function judge(checks:unknown[],capture?:Array<unknown>){return new ModelGoalJudge({adapterId:'fixture',complete:async request=>{capture?.push(request);return {modelId:'test',content:JSON.stringify({checks})}}},model)}
const input={evalCase:definition,left:{...evidence,side:'left' as const},right:evidence,profile:{} as any};
it('validates simple suites without placing criteria or credentials in task input',()=>{
 const parsed=simpleMigrationSuiteSchema.parse(simpleMigrationSuiteExample);expect(simpleMigrationCases(parsed)[0]!.prompt).toBe(parsed.cases[0]!.input);
 expect(()=>simpleMigrationSuiteSchema.parse({name:'test',cases:[{id:'a',input:'x',criteria:[]}]})).toThrow();
 expect(()=>simpleMigrationSuiteSchema.parse({name:'test',cases:[{id:'a',input:'x',criteria:['x']},{id:'a',input:'y',criteria:['y']}]})).toThrow();
 expect(()=>simpleMigrationSuiteSchema.parse({...simpleMigrationSuiteExample,credential:'secret'})).toThrow();
});
it('returns model goal checks with grounded evidence and no dimension scores',async()=>{
 const requests:unknown[]=[];
 const result=await judge([{criterionIndex:1,verdict:'PASS',reason:'说明未扣费',evidence:'尚未扣费'},{criterionIndex:0,verdict:'PASS',reason:'等价金额',evidence:'2.50 元'}],requests).compare(input);
 expect(result.dimensions).toEqual([]);expect(result.goalAssessment?.verdict).toBe('PASS');expect(result.goalAssessment?.checks[0]!.criterion).toBe('服务费为2.5元');
 const payload=JSON.parse((requests[0] as any).messages[1].content);expect(payload.answer).toBe(evidence.output);expect(payload.criteria).toEqual(['服务费为2.5元','说明尚未扣费']);
 expect(payload.runtimeEvidence).toEqual({status:'completed',streamCompleted:true,toolCalls:[],sourceFacts:[]});
 expect(assessMigrationAcceptance({cases:[{caseId:'fee-001',right:evidence,judge:result,judgeError:null}]} as any,[definition],true).status).toBe('PASSED');
});
it('gives the goal judge authoritative Runtime tool evidence instead of requiring tool narration in the answer',async()=>{
 const requests:unknown[]=[];
 const businessCall={name:'get_balance',status:'completed' as const,inputDigest:'a'.repeat(64),outputDigest:'b'.repeat(64),elapsedMs:2};
 const right={...evidence,toolCalls:[{name:'skill_tool',status:'completed' as const},businessCall,{name:'workspace_info',status:'completed' as const}],metadata:{toolEvidence:[{tool:'skill_tool',resultDigest:'ignored'},{tool:'get_balance',resultDigest:'c'.repeat(64)},{tool:'read_file',resultDigest:'ignored'}]}};
 const result=await judge([{criterionIndex:0,verdict:'PASS',reason:'Runtime 记录 get_balance 已完成',evidence:''},{criterionIndex:1,verdict:'PASS',reason:'回答说明尚未扣费',evidence:'尚未扣费'}],requests).compare({...input,right});
 const payload=JSON.parse((requests[0] as any).messages[1].content);
 expect(payload.runtimeEvidence.toolCalls).toEqual([businessCall]);
 expect(payload.runtimeEvidence.sourceFacts).toEqual([{tool:'get_balance',resultDigest:'c'.repeat(64)}]);
 expect(result.goalAssessment?.verdict).toBe('PASS');
});
it('distinguishes failed criteria and indeterminate outcomes from execution failure',async()=>{
 for(const verdict of ['FAIL','INDETERMINATE'] as const){const result=await judge([{criterionIndex:0,verdict,reason:'不满足或缺证据',evidence:''},{criterionIndex:1,verdict:'PASS',reason:'未扣费',evidence:'尚未扣费'}]).compare(input);expect(result.goalAssessment?.verdict).toBe(verdict);expect(assessMigrationAcceptance({cases:[{caseId:'fee-001',right:evidence,judge:result,judgeError:null}]} as any,[definition],true).status).toBe(verdict==='FAIL'?'FAILED':'NOT_VALIDATED')}
 await expect(judge([]).compare({...input,right:{...evidence,status:'failed'}})).rejects.toThrow('执行失败');
});
it('rejects missing criteria, duplicates, and fabricated quotes instead of returning a pass',async()=>{
 for(const checks of [[{criterionIndex:0,verdict:'PASS',reason:'x',evidence:''}],[{criterionIndex:0,verdict:'PASS',reason:'x',evidence:''},{criterionIndex:0,verdict:'PASS',reason:'x',evidence:''}],[{criterionIndex:0,verdict:'PASS',reason:'x',evidence:'伪造的回答'},{criterionIndex:1,verdict:'PASS',reason:'x',evidence:''}]])await expect(judge(checks).compare(input)).rejects.toThrow();
});
it('tells the model which quote failed before retrying without weakening evidence checks',async()=>{
 const requests:any[]=[];
 const evaluator=new ModelGoalJudge({adapterId:'retry',complete:async request=>{
  requests.push(request);
  return {modelId:'test',content:JSON.stringify({checks:[{criterionIndex:0,verdict:'PASS',reason:'金额符合',evidence:requests.length===1?'改写的金额':'2.50 元'},{criterionIndex:1,verdict:'PASS',reason:'未扣费',evidence:'尚未扣费'}]})};
 }},model);
 expect((await evaluator.compare(input)).goalAssessment?.verdict).toBe('PASS');
 expect(JSON.parse(requests[1].messages[1].content).previousResponseError).toContain('改写的金额');
});
it('recovers one continuous verbatim clause when the retry still joins multiple quotes',async()=>{
 let attempt=0;
 const evaluator=new ModelGoalJudge({adapterId:'joined-quotes',complete:async()=>{
  attempt++;
  return {modelId:'test',content:JSON.stringify({checks:[
   {criterionIndex:0,verdict:'PASS',reason:'金额符合',evidence:attempt===1?'改写的金额':'无关改写；服务费为人民币 2.50 元'},
   {criterionIndex:1,verdict:'PASS',reason:'未扣费',evidence:'尚未扣费'},
  ]})};
 }},model);
 const result=await evaluator.compare(input);
 expect(result.goalAssessment?.verdict).toBe('PASS');
 expect(result.goalAssessment?.checks[0]?.evidence).toBe('服务费为人民币 2.50 元');
});
it('makes candidate tools available without requiring every tool to be called for each natural-language task',async()=>{
 const manager=new EvaluationRunManager({environments:{}} as any);
 const scripts=[{name:'quote_fee',path:'scripts/fee.py',kind:'PYTHON',filePaths:['scripts/fee.py']}];
 const services=[{assetDigest:'a'.repeat(64),toolNames:['balance'],filePaths:['mcp/server.py'],start:['uv','run','mcp/server.py']}];
 const descriptor=await (manager as any).environmentDescriptor({environmentId:'runtime',mcpEnvironmentIds:[]},[],scripts,services,true);
 expect(descriptor.requiredToolNames).toEqual([]);expect(descriptor.availableToolNames).toEqual(['quote_fee','balance']);expect(descriptor.commandScripts).toEqual(scripts);expect(descriptor.candidateMcpServices).toEqual(services);
});
it('transports a standard text delivery package to the trusted Runtime without a legacy neutral declaration',async()=>{
 const archive={'skill/SKILL.md':strToU8('instructions'),'mcp-python/server.py':strToU8('server'),'skill/scripts/fee.py':strToU8('script')};
 const manager=new EvaluationRunManager({skills:{list:async()=>[{assetId:'asset',skillId:'skill',version:'1',artifactSha256:'a'.repeat(64)}],readFiles:async()=>({}),readArchive:async()=>archive,readSource:async()=>'instructions'}} as any);
 const resolve=await (manager as any).skillResolver('asset',true,true);
 const source=await resolve({mode:'skill_version',skillId:'skill',version:'1',artifactSha256:'a'.repeat(64)});
 expect(source.files['mcp-python/server.py']).toBe('server');expect(source.canonicalArchive).toBeUndefined();
});
it('imports and freezes the documented format through the migration API',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'migration-goals-')),app=await createEvaluationService({rootDirectory:path.resolve('.'),dataDirectory:dir,accessToken:'test',publicDemo:false}),headers={authorization:'Bearer test'};
 try{
  const sample=(await app.inject({url:'/api/migration-suite-example',headers})).json();simpleMigrationSuiteSchema.parse(sample);
  const asset=(await app.inject({url:'/api/skills/upload',method:'POST',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: goals\ndescription: test\nversion: 1.0.0\n---\nRead only')}))})).json();
  const project=(await app.inject({url:'/api/migrations',method:'POST',headers,payload:{sourceAssetId:asset.assetId,name:'goals'}})).json();
  const imported=await app.inject({url:`/api/migrations/${project.id}/suites/import`,method:'POST',headers,payload:sample});expect(imported.statusCode).toBe(200);expect(imported.json().assessmentMode).toBe('natural_language');
  const invalid=await app.inject({url:`/api/migrations/${project.id}/suites/import`,method:'POST',headers,payload:{name:'bad',cases:[{id:'a',input:'x',criteria:[]}]}});expect(invalid.statusCode).toBe(400);
  const report=(await app.inject({url:`/api/migrations/${project.id}/report`,headers})).json();expect(report.suites[0].cases[0].rubric[0].description).toBe(sample.cases[0].criteria[0]);
  const html=renderToStaticMarkup(createElement(MigrationAssessmentStep,{initialMode:'goals',api:async()=>({} as any),projectId:project.id,suites:report.suites,experiments:[],busy:false,refresh:async()=>{},runtimeId:'',setRuntimeId:()=>{},runtimes:[],modelKey:'',setModelKey:()=>{},packId:`suite:${imported.json().preparationId}`,setPackId:()=>{},run:()=>{},next:()=>{}}));expect(html).toContain('下载测试集样例');expect(html).toContain(sample.cases[0].criteria[0]);expect(html).toContain('执行并自动评估');
 }finally{await app.close();await rm(dir,{recursive:true,force:true})}
});
