import {approveMigrationPlanThroughUi} from './lib/verify-reuse-plan-ui.mjs';
/** Four enterprise fixtures through the real migration UI, Runtime and configured models. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {chromium,expect} from '@playwright/test';
import {createEvaluationService} from '../dist/service/server.js';
import {analyzeWithAgent,implementWithAgent} from '../dist/migration/infrastructure/migration-agent.js';
import {enterpriseSkills,selectedEnterpriseCases,writeAcceptanceResult} from './lib/migration-acceptance-results.mjs';
import {enterpriseImprovementSuite} from '../acceptance/enterprise-migration-examples/improvement-suites.mjs';
import {verifyImprovementThroughUi} from './lib/verify-improvement-ui.mjs';
import {verifyReuseDeliveryThroughUi} from './lib/verify-reuse-delivery-ui.mjs';
import {configuredModelRole,modelTimeoutMs} from '../dist/service/config.js';
import {createConfiguredReusePlanner} from '../dist/migration/infrastructure/migration-reuse-planner.js';
import {reuseModelContext} from '../dist/migration/infrastructure/migration-reuse-context.js';
import {canonicalSha256} from '../dist/shared/json-canonicalization.js';
const root=process.cwd(),fixtures=path.join(root,'acceptance/enterprise-migration-examples');
const report=path.join(root,'reports','enterprise-four-page-'+new Date().toISOString().replace(/[:.]/gu,'-'));await mkdir(report,{recursive:true});
const work=await mkdtemp(path.join(os.tmpdir(),'enterprise-four-page-'));assert.equal(path.dirname(work),path.resolve(os.tmpdir()));
const cfg=JSON.parse(await readFile(path.join(root,'.runtime.local.json'),'utf8'));const [modelId,model]=Object.entries(cfg.models).find(([,m])=>m.enabled!==false);
Object.assign(process.env,{FINANCE_EVAL_MIGRATION_AGENT:'on',FINANCE_EVAL_AGENT_ATTEMPTS:'1',FINANCE_EVAL_AGENT_DUMP:path.join(report,'agent-logs'),FINANCE_EVAL_JUDGE_PROVIDER:'openai_compatible',FINANCE_EVAL_JUDGE_BASE_URL:model.baseUrl,FINANCE_EVAL_JUDGE_API_KEY:model.apiKey,FINANCE_EVAL_JUDGE_MODEL:model.upstreamModelId??modelId,FINANCE_EVAL_JUDGE_REQUEST_DEFAULTS:JSON.stringify({...model.extraBody,max_tokens:32000})});
const python=path.join(root,'.venv-openjiuwen/Scripts/python.exe'),token='four-fixtures-page-test',outcomes=[];let current='',app,browser,worker,business,gateway;
const selectedCases=selectedEnterpriseCases(process.env.ENTERPRISE_TEST_CASES);
const recordedCandidateAnalysis=process.env.ENTERPRISE_TEST_CANDIDATE_A2_RECORD;
const recordedReviewDirectory=process.env.ENTERPRISE_TEST_REVIEW_DIRECTORY;
if(recordedCandidateAnalysis){
 assert.equal(selectedCases.length,1,'Candidate analysis replay is restricted to one explicitly selected asset');
 assert.match(process.env.ENTERPRISE_TEST_CANDIDATE_DIGEST??'',/^[a-f0-9]{64}$/,'Candidate analysis replay requires the exact previously analyzed asset digest');
}
const opts={projectRoot:root,modelId,providerId:model.providerId??'service-execution',timeoutMs:900000};
// Generation now also independently scans/analyzes/reviews the assembled candidate.
const generationTimeoutMs=opts.timeoutMs*2+modelTimeoutMs('ANALYZER')+60000;
process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS='1';
if(process.env.MIGRATION_TEST_OPTIMIZER_ROLE==='MIGRATION')for(const suffix of ['BASE_URL','API_KEY','MODEL','PROVIDER','REQUEST_DEFAULTS','TIMEOUT_MS']){
 const value=process.env[`FINANCE_EVAL_MIGRATION_${suffix}`];
 if(value!==undefined)process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`]=value;else delete process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`];
}
assert(configuredModelRole('OPTIMIZER').adapter,'Configure the real optimizer or explicitly select MIGRATION_TEST_OPTIMIZER_ROLE=MIGRATION');
async function save(name,value){let t=JSON.stringify(value,null,2);for(const m of Object.values(cfg.models))if(m.apiKey)t=t.replaceAll(m.apiKey,'[redacted]');const dest=path.join(report,name);await mkdir(path.dirname(dest),{recursive:true});await writeFile(dest,t)}
async function port(){const s=createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p}
async function ready(url,proc){for(let i=0;i<90;i++){if(proc.exitCode!==null)throw Error('Helper exited');try{if((await fetch(url,{signal:AbortSignal.timeout(1000)})).ok)return}catch{}await new Promise(r=>setTimeout(r,1000))}throw Error('Helper startup timeout')}
async function stop(proc){if(proc&&proc.exitCode===null)await new Promise(r=>{const c=spawn('taskkill',['/PID',String(proc.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});c.once('close',r)})}
try{
 const bp=await port(),wp=await port(),businessUrl=`http://127.0.0.1:${bp}`;
 const auditFile=path.join(work,'business-audit.jsonl');
 const audit=async()=> (await readFile(auditFile,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
 business=spawn(python,['-B',path.join(fixtures,'server.py'),'--port',String(bp),'--audit-file',auditFile],{cwd:root,windowsHide:true,env:{...process.env,PYTHONUTF8:'1'},stdio:'ignore'});await ready(businessUrl+'/health',business);
 const ws=path.join(work,'workspace');await mkdir(path.join(ws,'workspace'),{recursive:true});for(const file of ['EXP-001.json','EXP-002.json'])await writeFile(path.join(ws,'workspace',file),await readFile(path.join(fixtures,'01-expense/workspace',file)));
 const providers=JSON.parse(await readFile(path.join(fixtures,'worker-auth-providers.json'),'utf8'));
 const conf=path.join(work,'runtime.json');await writeFile(conf,JSON.stringify({...cfg,...providers,workspaceDirectory:ws}));
 worker=spawn(python,['-B','-m','uvicorn','integrations.openjiuwen.worker:app','--host','127.0.0.1','--port',String(wp)],{cwd:root,windowsHide:true,env:{...process.env,PYTHONUTF8:'1',DEMO_APP_KEY:'demo-app',FINANCE_RUNTIME_CONFIG:conf,PYTHONPATH:root+path.delimiter+path.join(fixtures,'supplements')},stdio:'ignore'});await ready(`http://127.0.0.1:${wp}/health`,worker);
 // Fixture gateway translates the frozen natural-language task into the old fixture's object request.
 // Actual business answers are obtained from original source execution; no expected answer is returned.
 gateway=createServer(async(req,res)=>{try{let body='';for await(const c of req)body+=c;const input=JSON.parse(body);const name=req.url.slice(1),targets=JSON.parse(await readFile(path.join(fixtures,name,'targets.json'),'utf8')),suite=JSON.parse(await readFile(path.join(fixtures,name,'suite.json'),'utf8'));const c=suite.cases.find(c=>c.caseId===input.case_id);assert.equal(input.task,c?.prompt);const target=targets.find(t=>t.caseId===c.caseId);const reply=await fetch(businessUrl+'/original/'+name,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({input:target.input})});res.writeHead(reply.status,{'content-type':'application/json'});res.end(await reply.text())}catch(e){res.writeHead(400);res.end()}});await new Promise(r=>gateway.listen(0,'127.0.0.1',r));
 let cachedA2Used=false;
 const configuredReusePlanner=createConfiguredReusePlanner(path.join(report,'model-calls'));
 const reusePlanner=async input=>{
  if(input.mode==='REVIEW'&&recordedReviewDirectory){
   assert.equal(selectedCases.length,1,'Review replay is restricted to one exact candidate');
   const project=JSON.parse(await readFile(path.join(recordedReviewDirectory,'candidate.json'),'utf8'));
   assert.equal(project.source.artifactSha256,input.sourceInspection.assetDigest);
   assert.equal(project.candidate.artifactSha256,input.candidateInspection.assetDigest);
   const {deliveryContract}=JSON.parse(await readFile(path.join(recordedReviewDirectory,'a4-input-contract.json'),'utf8'));
   // Candidate review uses this same delivery contract without the source manifest path hint.
   delete deliveryContract.skillDocumentation.sourceSkillFile;
   // The implementation envelope also carries approval metadata; REVIEW receives
   // the design separately, and its portableDeliveryContract has no approval envelope.
   delete deliveryContract.approvedReuseProposal;
   const previousContext=reuseModelContext({...input,sourceInspection:project.sourceInspection,candidateInspection:project.inspection,
    design:project.reuseProposal.design,deliveryContract});
   // Compare the JSON actually sent to the model (optional undefined fields are omitted).
   const wireDigest=value=>canonicalSha256(JSON.parse(JSON.stringify(value)));
   assert.equal(wireDigest(previousContext),wireDigest(reuseModelContext(input)),
    'Never reuse a review when source, candidate, design, actual dependencies or delivery contract changed');
   const result=JSON.parse(await readFile(path.join(recordedReviewDirectory,'reuse-review-result.json'),'utf8'));
   assert.equal(result.status,'REVIEWED');
   assert.equal(result.telemetry.sourceDigest,input.sourceInspection.assetDigest);
   assert.equal(result.telemetry.candidateDigest,input.candidateInspection.assetDigest);
   await save(current+'/reuse-review-result.json',result);console.log(current+' REUSE REVIEW REUSED_REAL');return result;
  }
  if(input.mode==='PROPOSE'&&process.env.ENTERPRISE_TEST_REUSE_RECORD){
   const record=JSON.parse(await readFile(process.env.ENTERPRISE_TEST_REUSE_RECORD,'utf8'));
   // The production planner still verifies source/tool evidence and approves a new digest.
   assert.equal(input.inspection.assetDigest,record.sourceDigest,'Recorded proposal must address this exact source asset');
   return {status:'PROPOSED',design:record.design};
  }
  console.log(current+' REUSE '+input.mode+' START');
  const result=await configuredReusePlanner(input);
  await save(current+'/reuse-'+input.mode.toLowerCase()+'-result.json',result);
  console.log(current+' REUSE '+input.mode+' '+result.status+' '+JSON.stringify(result.telemetry));
  return result;
 };
 app=await createEvaluationService({rootDirectory:root,dataDirectory:path.join(work,'data'),publicDemo:false,accessToken:token,migrationReusePlanner:reusePlanner,migrationAnalyzer:async input=>{
  console.log(current+' A2 START');
  let cached=!cachedA2Used&&process.env.ENTERPRISE_TEST_A2_RECORD;cachedA2Used=true;
  if(input.runId.endsWith('-verify')&&recordedCandidateAnalysis){
   assert.equal(input.assetDigest,process.env.ENTERPRISE_TEST_CANDIDATE_DIGEST,'Never reuse candidate analysis for different code');
   cached=recordedCandidateAnalysis;
  }
  const r=cached?JSON.parse(await readFile(cached,'utf8')):await analyzeWithAgent(input,opts);
  await save(current+'/a2-'+Date.now()+'.json',r);console.log(current+' A2 '+r?.status+(cached?' REUSED_REAL':''));return r;
 },migrationImplementer:async input=>{console.log(current+' A4 START');await save(current+'/a4-input-contract.json',{contract:input.contract,deliveryContract:input.deliveryContract});const r=process.env.ENTERPRISE_TEST_A4_RECORD?JSON.parse(await readFile(process.env.ENTERPRISE_TEST_A4_RECORD,'utf8')):await implementWithAgent(input,opts);await save(current+'/a4-result.json',r);console.log(current+' A4 '+r?.status);return r}});app.log.level='error';
 async function api(method,url,payload){const r=await app.inject({method,url,headers:{authorization:'Bearer '+token},...(payload===undefined?{}:{payload})});assert.ok(r.statusCode<400,r.body.slice(0,1000));return r.json()}
 process.env.FINANCE_MIGRATION_NATIVE_ENDPOINT=`http://127.0.0.1:${wp}/execute`;
 const env=await api('POST','/api/environments',{name:'四案例 DeepAgent',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:`http://127.0.0.1:${wp}`});const url=await app.listen({host:'127.0.0.1',port:0});browser=await chromium.launch({channel:'msedge',headless:true});
 for(current of selectedCases){
  const outcome={name:current,passed:false,checks:[],provenance:{diagnosis:process.env.ENTERPRISE_TEST_A2_RECORD??'fresh real model',candidateAnalysis:recordedCandidateAnalysis??'fresh real model',reuseProposal:process.env.ENTERPRISE_TEST_REUSE_RECORD??'fresh real model',candidateReview:recordedReviewDirectory??'fresh real model',generation:process.env.ENTERPRISE_TEST_A4_RECORD??'fresh real model',evaluation:'NOT_RUN'}};let phase='import';const ctx=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});await ctx.tracing.start({screenshots:true,snapshots:true});const page=await ctx.newPage();page.setDefaultTimeout(30000);const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  try{
   await page.goto(url);await page.getByLabel('访问令牌').fill(token);await page.getByRole('button',{name:'进入工作区',exact:true}).click();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.getByRole('button',{name:'新建迁移',exact:true}).click();
   phase='diagnosis';const inspect=page.waitForResponse(r=>r.url().endsWith('/inspect')&&r.request().method()==='POST',{timeout:900000});inspect.catch(()=>{});await page.locator('input[type=file]').first().setInputFiles({name:current+'.zip',mimeType:'application/zip',buffer:await readFile(path.join(fixtures,current,'source.zip'))});assert.ok((await inspect).ok());
   const projects=await api('GET','/api/migrations');
   // The newly uploaded project is identified by the source archive digest, independently of display name.
   const ordered=projects.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));const active=ordered[0],base='/api/migrations/'+active.id;outcome.projectId=active.id;
   phase='diagnosis';let rep=await api('GET',base+'/report');await save(current+'/diagnosis-initial.json',rep);
   for(let round=0;round<2&&rep.inspection.dependencyAnalysis?.status!=='COMPLETE';round++){
    let supplied=false;
    for(const d of rep.inspection.dependencyAnalysis?.dependencies??[]){if(!d.blocking||d.owner!=='TOOL'||d.availability==='AVAILABLE')continue;const card=page.locator('[data-dependency]').filter({has:page.locator('h4')}).filter({hasText:d.name}).first();
     await expect(card).toBeVisible();const marker=(d.key+' '+d.name).toLowerCase();if(d.kind==='SDK'&&marker.includes('auth')){const stored=page.waitForResponse(r=>r.url().includes('/file?')&&r.request().method()==='POST');await card.locator('input[type=file]').setInputFiles(path.join(fixtures,'supplements/auth_sdk.py'));assert.ok((await stored).ok());supplied=true}
     else if(marker.includes('department')){if(await card.locator('input[type=file]').count()){const stored=page.waitForResponse(r=>r.url().includes('/file?')&&r.request().method()==='POST');await card.locator('input[type=file]').setInputFiles(path.join(fixtures,'supplements/department_config.py'));assert.ok((await stored).ok());}else{const value={D001:{reserve:'100.00'}};await card.locator('textarea').first().fill(JSON.stringify(value));await card.getByRole('button',{name:'保存数据',exact:true}).click()}supplied=true}
     else throw Error('Blocking dependency could not be resolved: '+d.key+' '+d.name+' (source paths '+d.resolvedPaths.join(',')+')');
     await expect(card.getByText('正在保存…',{exact:true})).toHaveCount(0,{timeout:30000});
    }
    const rerun=page.waitForResponse(r=>r.url().endsWith('/inspect/source')&&r.request().method()==='POST',{timeout:900000});rerun.catch(()=>{});await page.getByRole('button',{name:'继续分析',exact:true}).click();assert.ok((await rerun).ok());rep=await api('GET',base+'/report');
   }
   if(current==='03-procurement'){
    const budgetTool=rep.inspection.tools.find(tool=>tool.name==='check_budget');
    const rules=rep.inspection.dependencyAnalysis?.dependencies.find(d=>
     d.binding?.kind==='HTTP_HEADER'&&d.binding.name.toLowerCase()==='x-department-rules'&&
     (!budgetTool||d.toolIds.includes(budgetTool.toolId)));
    assert.deepEqual(rules?.binding,{kind:'HTTP_HEADER',name:'X-Department-Rules'},'模型必须为结构化运行数据设计明确的 MCP Header 注入协议');
    assert.equal(rules?.blocking,true,'缺少部门规则时 check_budget 无法运行，但不能阻止生成');
   }
   await save(current+'/diagnosis.json',rep);await page.screenshot({path:path.join(report,current,'01-diagnosis.png'),fullPage:true});assert.equal(rep.inspection.dependencyAnalysis?.status,'COMPLETE','Diagnostic closure not reached');outcome.checks.push('real A2 diagnosis closed');
   // Expense explicitly exercises framework-independent Script → MCP migration;
   // procurement crosses into Java delivery.
   for(const [index,tool] of rep.inspection.tools.entries()){const language=current==='03-procurement'?'java':'python',label=current==='03-procurement'?'Java':'Python',card=page.locator('.diagnosis-tool').nth(index);await expect(card.locator('h3')).toContainText(tool.name);await card.getByLabel('转换形式').selectOption('MCP');await expect(card.getByLabel('转换形式')).toHaveValue('MCP');await card.getByLabel('实现语言').selectOption(language);await expect(card.getByLabel('实现语言')).toHaveValue(language);await expect(page.locator('.diagnosis-plan').getByText(`${tool.name} → ${label} MCP 服务`,{exact:true})).toBeVisible()}
   phase='reuse-proposal';await approveMigrationPlanThroughUi(page,proposal=>save(current+'/reuse-proposal.json',proposal));
   await page.screenshot({path:path.join(report,current,'02-reuse-plan.png'),fullPage:true});
await page.getByRole('button',{name:'确认方案，进入生成',exact:true}).click();phase='generation';await expect(page.getByRole('button',{name:'开始生成',exact:true})).toBeEnabled({timeout:30000});rep=await api('GET',base+'/report');await save(current+'/plan-report.json',rep);assert.equal(rep.migrationPlan?.generationAllowed,true,JSON.stringify(rep.migrationPlan));const gen=page.waitForResponse(r=>r.url().endsWith('/generate')&&r.request().method()==='POST',{timeout:generationTimeoutMs});gen.catch(()=>{});await page.getByRole('button',{name:'开始生成',exact:true}).click();const gr=await gen;assert.ok(gr.ok(),await gr.text());const generated=await gr.json();await save(current+'/candidate.json',generated);assert.ok(generated.candidate);outcome.checks.push('real A4 candidate generated');
   await page.locator('.stage-actions').getByRole('button',{name:'Runtime 适配与登记',exact:true}).click();await page.locator('.stage-actions').getByRole('button',{name:'验证能否运行',exact:true}).click();rep=await api('GET',base+'/report');phase='runtime-configuration';
   for(const d of rep.project.sourceInspection.dependencyAnalysis.dependencies.filter(d=>d.owner==='RUNTIME'&&d.action==='INJECT')){
    const card=page.locator('[data-dependency]').filter({hasText:d.name}).first(),marker=(d.key+' '+d.binding?.name+' '+d.name).toLowerCase();let value;
    if(marker.includes('workspace'))value={workspace:path.join(ws,'workspace')};else if(marker.includes('department')&&marker.includes('rule'))value={D001:{reserve:'100.00'}};else if(marker.includes('user'))value={id:'U001',tenantId:'T001'};else if(marker.includes('timeout'))value=30;else if(marker.includes('service')||marker.includes('url'))value=businessUrl;else if(marker.includes('credential')||marker.includes('authorization')||marker.includes('token'))value='Bearer fixture:T001:U001';else if(marker.includes('app')||marker.includes('key'))value='demo-app';else if(marker.includes('tenant'))value='T001';else throw Error('Unknown Runtime value: '+d.key);
    if(typeof value==='object'&&d.schema?.properties&&Object.values(d.schema.properties).every(s=>s.type==='string')){for(const [k,v] of Object.entries(value))await card.getByLabel(new RegExp('^'+k)).fill(v)}else if(await card.locator('textarea').count())await card.locator('textarea').fill(JSON.stringify(value));else await card.locator('input').first().fill(typeof value==='string'?value:JSON.stringify(value));const saved=page.waitForResponse(r=>r.url().includes('/runtime-configuration/')&&r.request().method()==='PUT');await card.getByRole('button',{name:d.binding?.kind==='SERVICE_ENV'?'保存服务配置':'保存测试数据',exact:true}).click();assert.ok((await saved).ok());await expect(card.getByText('正在保存…',{exact:true})).toHaveCount(0,{timeout:30000});
   }
   phase='technical';const inputs={check_expense:{claim_id:'EXP-001'},get_balance:{account_id:'ACC-001'},get_request:{request_id:'PO-001'},check_budget:{department:'D001',amount:'500.00'},check_supplier:{supplier:'S001'},refund_eligibility:{order_id:'RF-001'}};
   for(const tool of rep.inspection.tools){const card=page.locator('article[id="migration-tool-'+tool.toolId+'"]');assert.ok(inputs[tool.name],'Unknown tool '+tool.name);await card.getByText('高级设置：覆盖自动测试参数',{exact:true}).click();await card.locator('textarea').fill(JSON.stringify(inputs[tool.name]));const trial=page.waitForResponse(r=>r.url().endsWith('/validate/technical')&&r.request().method()==='POST',{timeout:180000});trial.catch(()=>{});await card.getByRole('button',{name:'开始试运行',exact:true}).click();const result=await (await trial).json();await save(current+'/technical-'+tool.name+'.json',result);assert.equal(result.status,'PASSED',JSON.stringify(result).slice(0,1800));await expect(card.getByText('验证通过',{exact:true})).toBeVisible({timeout:30000})}outcome.checks.push('generated tools passed real technical trials');
   await page.locator('.stage-actions').getByRole('button',{name:'验证实际效果',exact:true}).click();await page.getByRole('button',{name:/接入原服务做对比/}).click();const suite=JSON.parse(await readFile(path.join(fixtures,current,'suite.json'),'utf8'));await page.getByLabel('原服务地址').fill(`http://127.0.0.1:${gateway.address().port}/${current}`);await page.getByLabel('请求 JSON 模板').fill(JSON.stringify({task:'{{input}}',case_id:'{{caseId}}'}));await page.getByLabel('回答字段').fill('/data/businessResult');await page.getByLabel('预览或编辑测试集').fill(JSON.stringify({name:current,cases:suite.cases.map(c=>({id:c.caseId,input:c.prompt,criteria:c.rubric.map(r=>r.description),...(c.workspaceFiles?.length?{workspaceFiles:c.workspaceFiles}:{})}))}));const imported=page.waitForResponse(r=>r.url().endsWith('/suites/import')&&r.request().method()==='POST');await page.getByRole('button',{name:'确认并导入',exact:true}).click();assert.ok((await imported).ok());const execution=page.locator('.assessment-config-grid');await expect(execution.locator('select').nth(0)).not.toHaveValue('');await execution.locator('select').nth(1).selectOption(env.environmentId);await execution.locator('select').nth(2).selectOption(modelId);
   phase='comparison';const started=page.waitForResponse(r=>r.url().endsWith('/validate/openjiuwen')&&r.request().method()==='POST');started.catch(()=>{});await page.getByRole('button',{name:'执行两侧并自动对比',exact:true}).click();const sh=await started;assert.ok(sh.ok(),await sh.text());const run=await sh.json();let job;for(let i=0;i<900;i++){job=await api('GET','/api/runs/'+run.job.jobId);if(['completed','failed','cancelled','interrupted'].includes(job.status))break;await new Promise(r=>setTimeout(r,1000))}await save(current+'/comparison-job.json',job);assert.equal(job.status,'completed');outcome.acceptance=(await api('GET',base+'/report')).verification.targetExecution;assert.equal(outcome.acceptance,'PASSED',JSON.stringify((await api('GET',base+'/report')).openJiuwenValidations));outcome.verdicts=job.report.cases.map(c=>({id:c.caseId,verdict:c.judge?.serviceComparison?.verdict,judgeError:c.judgeError}));assert.ok(outcome.verdicts.every(c=>c.verdict==='PASS'),JSON.stringify(outcome.verdicts));outcome.checks.push('all three branches passed original-service comparison');await expect(page.getByText('最新 3/3 通过',{exact:true})).toBeVisible({timeout:30000});await page.screenshot({path:path.join(report,current,'02-results.png'),fullPage:true});
   for(const c of job.report.cases){const expectedTool=({'01-expense':'check_expense','02-balance':'get_balance','03-procurement':'get_request','04-refund':'refund_eligibility'}[current]);assert.ok(c.right.toolCalls.some(call=>call.name===expectedTool&&call.status==='completed'),'Missing real tool call in '+c.caseId)}outcome.checks.push('every candidate case contains an actual completed tool call');
   outcome.provenance.evaluation='fresh runtime and model judge';
   phase='improvement';const auditStart=(await audit()).length;
   outcome.improvement=await verifyImprovementThroughUi({page,api,base,suite:enterpriseImprovementSuite(current,suite),persistEvidence:async evidence=>{
    for(const [name,value] of Object.entries(evidence))await save(current+'/improvement-'+name+'.json',value);
   },verifyExternalEvidence:async()=>{
    if(current!=='02-balance')return [];
    const calls=(await audit()).slice(auditStart).filter(c=>c.operation==='balance'&&c.payload.account_id==='ACC-103');
    assert(calls.length>0,'The identity challenge must reach the business service');
    assert(calls.every(c=>c.userId==='U001'&&c.result.error==='PERMISSION_DENIED'),'Prompt must not override the configured authenticated identity');
    return ['business_service_independently_verified_configured_identity_and_rejection'];
   }});
   outcome.checks.push('frozen development, independent behavioral holdout, explicit adoption and persisted UI');
   await save(current+'/improvement-result.json',outcome.improvement);
   await page.screenshot({path:path.join(report,current,'03-improvement.png'),fullPage:true});
   phase='reuse-delivery';outcome.deliveryEvidence=await verifyReuseDeliveryThroughUi({page,api,base,
    downloadPath:path.join(report,current,'candidate.zip'),persistEvidence:async evidence=>{
      for(const [name,value] of Object.entries(evidence))await save(current+'/'+name+'.json',value);
    }});
   outcome.checks.push('current_candidate_reuse_requirements_executed','verified_export_identity_checked');
   await page.screenshot({path:path.join(report,current,'04-verified-delivery.png'),fullPage:true});assert.deepEqual(errors,[]);outcome.passed=true;
  }catch(e){outcome.phase=phase;outcome.error=String(e);await page.screenshot({path:path.join(report,current,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(path.join(report,current,'failure-page.txt'),await page.locator('body').innerText().catch(()=>''));console.error(current+' FAILED '+phase+' '+String(e).slice(0,1800))}
  finally{await ctx.tracing.stop({path:path.join(report,current,'browser-trace.zip')}).catch(()=>{});await ctx.close();outcomes.push(outcome);await save('result.json',{passed:outcomes.length===selectedCases.length&&outcomes.every(o=>o.passed),model:model.upstreamModelId??modelId,outcomes,report});console.log(current+' FINISHED '+outcome.passed)}
 }
 console.log(JSON.stringify({report,outcomes}));if(outcomes.some(o=>!o.passed))process.exitCode=1;
}finally{await browser?.close();await app?.close();if(gateway)await new Promise(r=>gateway.close(r));await stop(worker);await stop(business);
 await writeAcceptanceResult(outcomes.map(o=>({skillId:enterpriseSkills[o.name],passed:o.passed,
   provenance:{diagnosis:[o.provenance.diagnosis,o.provenance.reuseProposal].every(v=>v==='fresh real model')?'REAL':'REUSED_REAL',
     generation:[o.provenance.generation,o.provenance.candidateAnalysis,o.provenance.candidateReview].every(v=>v==='fresh real model')?'REAL':'REUSED_REAL',
     execution:o.verdicts?.length?'REAL':'NOT_RUN',judge:o.verdicts?.length?'REAL':'NOT_RUN'},
   cases:o.improvement?.cases??(o.verdicts??[]).map(c=>({caseId:c.id,verdict:c.verdict??'UNKNOWN'})),checks:o.checks,
   ...(o.deliveryEvidence?{deliveryEvidence:o.deliveryEvidence}:{}),
   phases:o.passed?['migration','technical','original-comparison','improvement','final-verification','adoption','reuse-acceptance','verified-export']:[]})));
 if(process.env.MIGRATION_TEST_RETAIN_DATA==='true')console.error('Retained private test data: '+work);
 else await rm(work,{recursive:true,force:true})}
