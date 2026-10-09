/** Real UI/runtime/Judge acceptance of the reuse executor. The portable fixture,
 * source inspection and migration design are explicitly authored test inputs,
 * not a claim of fresh model-driven Skill migration or source review. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';import os from 'node:os';
import {zipSync,strToU8} from 'fflate';
import {chromium,expect} from '@playwright/test';
import {Agent} from 'undici';
import {createEvaluationService} from '../dist/service/server.js';
import {SkillStore} from '../dist/service/skill-store.js';
import {MigrationProjectRepository} from '../dist/migration/infrastructure/migration-project-repository.js';
import {reuseInputDigest} from '../dist/migration/domain/migration-reuse-design.js';
import {stableToolId} from '../dist/migration/domain/migration-model.js';

const root=process.cwd(),builder=process.env.REUSE_TEST_BUILDER_ROOT??path.resolve(root,'../agent-store-builder-dev-wo-fork/community/finance/builder/finance-solution-builder');
const planReport=process.env.REUSE_UI_PLAN_REPORT,planSource=planReport?'REUSED_REAL_MODEL_PLAN':'REAL_MODEL_GENERATED';
const python=process.env.REUSE_TEST_PACKAGE_PYTHON??'C:/fb-pkg-py317/Scripts/python.exe';
const cfg=JSON.parse(await readFile(path.join(root,'.runtime.local.json'),'utf8'));
const [configuredId,model]=Object.entries(cfg.models).find(([,m])=>m.enabled!==false);
assert(model.apiKey&&model.baseUrl,'Configure a real model; no model stand-in is used');
const report=path.join(root,'reports',`reuse-acceptance-ui-${new Date().toISOString().replace(/[:.]/gu,'-')}`);await mkdir(report,{recursive:true});
const work=await mkdtemp(path.join(os.tmpdir(),'reuse-acceptance-ui-'));assert.equal(path.dirname(work),path.resolve(os.tmpdir()));
const children=[];let app,browser,page,relay,activeProjectId,launcherError='';const upstreamModel=model.upstreamModelId??configuredId;
// The model deadline is 10 minutes; Node's default 5-minute response-header
// timeout must not silently override it. Scope this dispatcher to our own bridge.
const originalFetch=globalThis.fetch,modelDispatcher=new Agent({headersTimeout:600000,bodyTimeout:600000});
async function helper(args){const child=spawn('uv',['run','--extra','test','python','engineering/verify_eval_package_native.py','--python',python,'--model-base',relayUrl,'--model-name',upstreamModel,...args],{cwd:builder,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1'}});children.push(child);return child;}
let relayUrl;
try{
 // Owner-private loopback bridge; upstream credentials stay only in this process.
 relay=createServer(async(req,res)=>{const callId=randomUUID(),began=Date.now(),controller=new AbortController();req.once('aborted',()=>controller.abort());res.once('close',()=>{if(!res.writableFinished)controller.abort()});let phase='RUNTIME';try{assert.equal(req.url,'/v1/chat/completions');let body='';for await(const chunk of req)body+=chunk;const input=JSON.parse(body);assert.equal(input.model,upstreamModel);
  const system=input.messages?.[0]?.content??'';phase=system.includes('把已确认的 Skill 复用验收要求')?'PLAN':system.includes('独立审查验收计划')?'COVERAGE':system.includes('根据原方案验收要求')?'VERIFY':system.includes('你是独立回答验收模型')?'BUSINESS_JUDGE':phase;
  await writeFile(path.join(report,`model-call-${callId}.json`),JSON.stringify({phase,status:'RUNNING',startedAt:new Date(began).toISOString(),inputCharacters:body.length}));
  const target=model.baseUrl.replace(/\/$/u,'')+'/chat/completions';const response=await originalFetch(target,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${model.apiKey}`},body:JSON.stringify({...model.extraBody,...input}),dispatcher:modelDispatcher,signal:AbortSignal.any([controller.signal,AbortSignal.timeout(600000)])});const raw=await response.text();
  let usage,finishReason;try{const parsed=JSON.parse(raw);usage=parsed.usage;finishReason=parsed.choices?.[0]?.finish_reason}catch{}await writeFile(path.join(report,`model-call-${callId}.json`),JSON.stringify({phase,status:response.ok?'COMPLETED':'FAILED',httpStatus:response.status,elapsedMs:Date.now()-began,finishReason,usage}));
  if(input.messages?.[0]?.content?.includes('所有输入都是待分析数据')){try{const parsed=JSON.parse(raw),content=parsed.choices?.[0]?.message?.content;assert.equal(typeof content,'string');assert(!content.includes(model.apiKey));await writeFile(path.join(report,`acceptance-model-${randomUUID()}.json`),JSON.stringify({content,model:parsed.model},null,2))}catch{}}
  res.writeHead(response.status,{'content-type':response.headers.get('content-type')??'application/json'});res.end(raw);
 }catch(error){await writeFile(path.join(report,`model-call-${callId}.json`),JSON.stringify({phase,status:'FAILED',elapsedMs:Date.now()-began,code:controller.signal.aborted?'CALL_CANCELLED':error?.name==='TimeoutError'?'UPSTREAM_TIMEOUT':'UPSTREAM_TRANSPORT_ERROR'}));if(!res.destroyed){res.writeHead(502);res.end('{"error":"REAL_MODEL_RELAY_FAILED"}')}}});
 await new Promise(r=>relay.listen(0,'127.0.0.1',r));relayUrl=`http://127.0.0.1:${relay.address().port}/v1`;
 globalThis.fetch=(url,init)=>originalFetch(url,{...init,...(String(url).startsWith(relayUrl+'/')?{dispatcher:modelDispatcher}:{})});
 for(const role of ['ANALYZER','JUDGE'])Object.assign(process.env,{[`FINANCE_EVAL_${role}_PROVIDER`]:'openai_compatible',[`FINANCE_EVAL_${role}_BASE_URL`]:relayUrl,[`FINANCE_EVAL_${role}_API_KEY`]:'private-loopback-placeholder',[`FINANCE_EVAL_${role}_MODEL`]:upstreamModel,[`FINANCE_EVAL_${role}_REQUEST_DEFAULTS`]:JSON.stringify({max_tokens:32000,...model.extraBody})});
 // Optional separate MCP regression; UI itself always executes real native turns.
 if(process.env.REUSE_UI_NATIVE_PRECHECK==='true'){
 const native=await helper(['--state-root',path.join(work,'native-check'),'--port','0']);let nativeText='',nativeError='';native.stdout.on('data',b=>{nativeText+=b.toString()});native.stderr.on('data',b=>{nativeError+=b.toString()});
 const nativeCode=await new Promise((resolve,reject)=>{native.once('close',resolve);native.once('error',reject)});
 const redact=value=>value.replaceAll(model.apiKey,'[REDACTED]').replaceAll('acceptance-private-binding','[REDACTED]');
 await writeFile(path.join(report,'native-result.jsonl'),redact(nativeText));await writeFile(path.join(report,'native-error.log'),redact(nativeError));
 assert.equal(nativeCode,0,'Native real-model regression failed; see private native-error.log');
 assert(nativeText.includes('"retainedOpaqueHandle": true'));
 console.log('Native real-model multi-turn opaque MCP handle: PASSED');
 }
 const launcherRoot=path.join(work,'launcher'),launcher=await helper(['--state-root',launcherRoot,'--port','0','--serve','--capture-tool-results']);launcher.stdout.resume();launcher.stderr.on('data',b=>{launcherError=(launcherError+b.toString()).slice(-2000000)});
 let info;for(let i=0;i<90;i++){assert.equal(launcher.exitCode,null,'Private test Launcher exited');try{info=JSON.parse(await readFile(path.join(launcherRoot,'connection-info.json'),'utf8'));if(info.status==='READY')break}catch{}await new Promise(r=>setTimeout(r,1000))}assert.equal(info?.status,'READY');
 process.env.REUSE_UI_LAUNCHER_TOKEN=info.token;process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS='1';
 const data=path.join(work,'data'),skills=new SkillStore(data);await skills.initialize();
 const files={'SKILL.md':'---\nname: reusable-quote\ndescription: Calculate a quote using workspace input and preserved native conversation.\n---\nRead input.json using read_file. It contains selection_code, price and quantity. If asked to wait, report the selection_code and wait without calculating. When the user continues, use the previously read values, call calculate_total, and report selection_code and total to two decimal places. Never invent values or reread files when the continuation forbids it. Missing input must be reported.\n',
 'scripts/calculate_total.py':'import json,sys\nfrom decimal import Decimal\nv=json.load(sys.stdin)\nprint(json.dumps({"total":str((Decimal(v["price"])*Decimal(str(v["quantity"]))).quantize(Decimal("0.01")))}))\n'};
 const archive=Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([p,t])=>[p,strToU8(t)])))),source=await skills.uploadZip(archive,{version:'1.0.0'}),candidate=await skills.uploadZip(archive,{version:'1.1.0'});
 const tool={toolId:stableToolId('calculate_total',['scripts/calculate_total.py']),name:'calculate_total',sourcePaths:['scripts/calculate_total.py'],language:'Python',kind:'SCRIPT',portability:'PORTABLE_SCRIPT',
  inputSchema:{type:'object',properties:{price:{type:'string'},quantity:{type:'integer'}},required:['price','quantity']},outputSchema:{type:'object',properties:{total:{type:'string'}}},samples:[{input:{price:'13.37',quantity:3},path:'SKILL.md',line:5}],evidence:[{path:'scripts/calculate_total.py',line:1,kind:'SOURCE',detail:'Authored test fixture'}],findings:[],recommendedForm:'SCRIPT',recommendedLanguage:'python',recommendationReason:'Authored portable fixture',entrypoint:{kind:'PYTHON',path:'scripts/calculate_total.py'}};
 const inspection={assetId:source.assetId,assetDigest:source.artifactSha256,inspectedAt:new Date().toISOString(),skill:{status:'COMPLIANT',findings:[]},tools:[tool],scriptsExecuted:false,staticAnalysis:{status:'COMPLETE',dependencyStatus:'NO_BINDING_IN_CHECKED_SCOPE',scannerDigest:source.artifactSha256,incompleteFiles:[]}};
 const decisions=[{toolId:tool.toolId,form:'SCRIPT',language:'python',reason:'Authored test fixture',baseAssetId:source.assetId,decidedAt:new Date().toISOString()}];
 const design={scope:'同一 Skill 在独立案例、新实例与真实多轮会话中复用',preservedBehavior:['按输入 price × quantity 计算两位小数总额'],sourceCouplings:[],changes:[{id:'portable',title:'保持独立计算脚本',implementation:'使用交付的 calculate_total 工具，不改写公式',toolNames:['calculate_total'],evidence:[{path:'scripts/calculate_total.py',snippet:files['scripts/calculate_total.py']}]}],dependencies:[],conditions:['Runtime 提供隔离工作区的 read_file 和真实原生多轮会话','运行数据只放入各案例的 input.json'],unresolvedQuestions:[],acceptanceChecks:[
  {id:'continuation',purpose:'真实多轮续接',procedure:'挂载 input.json：selection_code=SELECT-A, price=13.37, quantity=3。第一轮只实际调用 read_file 读取并等待；第二轮不再提供这些值，也不允许再次读取，由原生会话保留上轮信息并实际调用 calculate_total。',expectedResult:'第二轮输出 SELECT-A 和总额 40.11；第二轮不调用 read_file。'},
  {id:'isolation',purpose:'不同案例不串运行数据',procedure:'在同一运行组设置两个独立案例，各自挂载 input.json，selection_code 都为 SELECT-X；一个 price=2.51 quantity=5，另一个 price=4.25 quantity=2。分别读取并计算。',expectedResult:'两个案例分别输出 12.55 和 8.50，原生会话/工作区标识不同，不使用另一案例的数据。'},
  {id:'fresh-instance',purpose:'新实例可复用',procedure:'在新的运行组启动新的 Runtime 实例，再挂载 continuation 的 input.json，重复同样的两轮步骤。',expectedResult:'新实例仍在第二轮输出 SELECT-A 和 40.11；instanceId 与原运行组不同，第二轮不再读取文件。'}]};
 const proposal={proposalId:'authored-reuse-design',sourceDigest:source.artifactSha256,inputDigest:reuseInputDigest(inspection,decisions,source.artifactSha256),createdAt:new Date().toISOString(),approvedAt:new Date().toISOString(),design};
 const id='migration-'+randomUUID(),repository=new MigrationProjectRepository(data);
 activeProjectId=id;
 await repository.save({schemaVersion:'finance.skill-migration.v2',id,name:'复用验收执行器 · 原生多轮',createdAt:new Date().toISOString(),source,candidate,candidateNotes:'Authored portable fixture, not model-generated migration',sourceInspection:inspection,inspection:{...inspection,assetId:candidate.assetId,assetDigest:candidate.artifactSha256,reuseConformance:{proposalId:proposal.proposalId,candidateDigest:candidate.artifactSha256,reviewedAt:new Date().toISOString(),review:{changes:[{changeId:'portable',status:'CONFORMING',reason:'Authored test fixture',evidence:design.changes[0].evidence}],unexpectedDependencies:[],semanticIssues:[]},acceptanceChecks:design.acceptanceChecks.map(c=>({checkId:c.id,status:'NOT_RUN'}))}},decisions:decisions.map(d=>({...d,baseAssetId:candidate.assetId})),reuseProposal:proposal,candidateReuseProposalId:proposal.proposalId,runs:[],suiteIds:[],assessment:'NOT_VALIDATED'});
 const accessToken='private-reuse-acceptance-test';app=await createEvaluationService({rootDirectory:root,dataDirectory:data,accessToken,publicDemo:false});app.log.level='silent';
 const api=async(method,url,payload)=>{const response=await app.inject({method,url,headers:{authorization:`Bearer ${accessToken}`},...(payload===undefined?{}:{payload})});assert.equal(response.statusCode,200,response.body.slice(0,500));return response.json()};
 const environment=await api('POST','/api/environments',{name:'Native reusable package Runtime',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:info.baseUrl,credentialEnv:'REUSE_UI_LAUNCHER_TOKEN'});
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});page=await browser.newPage({viewport:{width:1440,height:1100}});const browserErrors=[];page.on('pageerror',e=>browserErrors.push(e.message));
 await page.goto(await app.listen({host:'127.0.0.1',port:0}));await page.getByLabel('访问令牌').fill(accessToken);await page.getByRole('button',{name:'进入工作区',exact:true}).click();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.getByRole('button',{name:'继续处理',exact:true}).click();
 await page.getByRole('navigation',{name:'迁移步骤'}).getByRole('button',{name:'验证能否运行',exact:true}).click();
 const section=page.getByRole('region',{name:'复用验收'});await section.getByLabel('复用验收 Runtime',{exact:true}).selectOption(environment.environmentId);await section.getByLabel('复用验收执行模型',{exact:true}).selectOption(info.modelId);
 console.log(`UI: ${planSource}, independently reviewing coverage against current inputs`);
 let priorPlan;
 if(planReport){const priorDirectory=path.resolve(root,planReport),priorSummary=JSON.parse(await readFile(path.join(priorDirectory,'summary.json'),'utf8')),priorReport=JSON.parse(await readFile(path.join(priorDirectory,'failure-report.json'),'utf8'));
  assert.equal(priorSummary.status,'PASSED','Only a previously executed real plan may be reused');
  assert.deepEqual(priorReport.project.reuseProposal.design,design,'Original scope and requirements must not change');priorPlan=priorSummary.plan.plan;
  await section.getByText('编辑验收计划（可选）',{exact:true}).click();await section.getByLabel('验收计划 JSON').fill(JSON.stringify(priorPlan));}
 const planResponse=page.waitForResponse(r=>r.url().endsWith('/reuse-acceptance/plan')&&r.request().method()==='POST',{timeout:900000});void planResponse.catch(()=>{});await section.getByRole('button',{name:priorPlan?'检查并保存计划':'生成验收计划',exact:true}).click();const planReply=await planResponse;assert.equal(planReply.status(),200,await planReply.text());
 const planned=(await api('GET',`/api/migrations/${id}/reuse-acceptance`)).plan;await writeFile(path.join(report,'plan.json'),JSON.stringify(planned,null,2));assert.equal(planned.coverage.status,'COVERED',planned.coverage.reasons.join('; '));assert(planned.plan.groups.length>=2);assert(planned.plan.groups.some(g=>g.cases.some(c=>c.turns)));
 const unapproved=await app.inject({method:'POST',url:`/api/migrations/${id}/reuse-acceptance/start`,headers:{authorization:`Bearer ${accessToken}`},payload:{planId:planned.planId,inputDigest:planned.inputDigest}});assert.equal(unapproved.statusCode,409);
 await section.getByRole('button',{name:'确认验收计划',exact:true}).click();await expect(section.getByRole('button',{name:'执行复用验收',exact:true})).toBeEnabled();
 await page.screenshot({path:path.join(report,'01-plan.png'),fullPage:true});const startedResponse=page.waitForResponse(r=>r.url().endsWith('/reuse-acceptance/start')&&r.request().method()==='POST');await section.getByRole('button',{name:'执行复用验收',exact:true}).click();const startedReply=await startedResponse;assert.equal(startedReply.status(),200,await startedReply.text());const startedTask=await startedReply.json();
 console.log('UI: executing confirmed reuse cases with real Runtime and Judge');
 await expect.poll(async()=>{const s=await api('GET',`/api/migrations/${id}/reuse-acceptance`);return s.result?.taskId===startedTask.taskId?s.result.status:'RUNNING';},{timeout:1800000,intervals:[2000]}).not.toBe('RUNNING');
 const summary=await api('GET',`/api/migrations/${id}/reuse-acceptance`),jobs=await Promise.all(summary.result.jobs.map(j=>api('GET',`/api/runs/${j.jobId}`)));
 await writeFile(path.join(report,'summary.json'),JSON.stringify(summary,null,2));await writeFile(path.join(report,'jobs.json'),JSON.stringify(jobs,null,2));assert.equal(summary.status,'PASSED',summary.result.reason??JSON.stringify(summary.result.checks));
 assert(jobs.every(j=>j.report.cases.every(c=>c.right.status==='completed'&&c.judge.goalAssessment.verdict==='PASS')));
 const groupInstances=jobs.map(j=>new Set(j.report.cases.map(c=>c.right.metadata.instanceId)));assert(groupInstances.every(s=>s.size===1));assert.equal(new Set(groupInstances.flatMap(s=>[...s])).size,jobs.length);
 const integrated=(await api('GET',`/api/migrations/${id}/report`)).technicalValidations;assert(integrated.some(v=>v.toolId===tool.toolId&&v.mode==='RUNTIME_INTEGRATED'&&v.status==='PASSED'));
 await page.reload();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.getByRole('button',{name:'继续处理',exact:true}).click();await page.getByRole('navigation',{name:'迁移步骤'}).getByRole('button',{name:'验证实际效果',exact:true}).click();await expect(page.getByRole('region',{name:'复用验收'}).getByText('通过',{exact:true}).first()).toBeVisible();
 await page.screenshot({path:path.join(report,'02-passed.png'),fullPage:true});assert.deepEqual(browserErrors,[]);
 // A reuse run must not masquerade as ordinary business assessment.
 assert.equal((await api('GET',`/api/migrations/${id}/report`)).verification.targetExecution,'NOT_RUN');
 let exported=await app.inject({method:'GET',url:`/api/migrations/${id}/export`,headers:{authorization:`Bearer ${accessToken}`}});
 assert.equal(exported.headers['x-migration-acceptance'],'UNVERIFIED');assert(exported.headers['content-disposition'].includes('-unverified.zip'));
 const businessSuite={name:'Independent business assessment',cases:[{id:'business-price',input:'Read input.json and complete the quote using the Skill.',
  criteria:['Actually call read_file and calculate_total. Report selection_code BUSINESS-Y and total 22.14.'],workspaceFiles:[{path:'input.json',content:JSON.stringify({selection_code:'BUSINESS-Y',price:'7.38',quantity:3})}],turns:[{query:'Read input.json and complete the quote using the Skill.',requiredTools:['read_file','calculate_total']}]}]};
 await page.getByRole('button',{name:'提供测试集和目标',exact:false}).click();await page.getByLabel('预览或编辑测试集').fill(JSON.stringify(businessSuite));await page.getByRole('button',{name:'确认并导入',exact:true}).click();
 // A wrapped label includes its options in its accessible text; scope to business
 // configuration so it cannot accidentally select the separate reuse controls.
 const businessConfig=page.locator('.assessment-config-grid');await businessConfig.getByLabel(/^Runtime/u).selectOption(environment.environmentId);await businessConfig.getByLabel(/^执行模型/u).selectOption(info.modelId);
 const businessResponse=page.waitForResponse(r=>r.url().endsWith('/validate/openjiuwen')&&r.request().method()==='POST');await page.getByRole('button',{name:'执行并自动评估',exact:true}).click();const businessReply=await businessResponse;assert.equal(businessReply.status(),200,await businessReply.text());const businessJob=(await businessReply.json()).job;
 await expect.poll(async()=> (await api('GET',`/api/runs/${businessJob.jobId}`)).status,{timeout:600000,intervals:[2000]}).toBe('completed');
 const finalReport=await api('GET',`/api/migrations/${id}/report`);await writeFile(path.join(report,'delivery-report.json'),JSON.stringify(finalReport,null,2));assert.equal(finalReport.verification.delivery.status,'VERIFIED',JSON.stringify(finalReport.verification));
 await page.reload();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.getByRole('button',{name:'继续处理',exact:true}).click();await page.getByRole('navigation',{name:'迁移步骤'}).getByRole('button',{name:'下载结果',exact:true}).click();
 await expect(page.getByRole('region',{name:'交付检查'})).toBeVisible();await expect(page.getByText('当前版本已通过自动检查',{exact:true})).toBeVisible();
 const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'下载迁移包',exact:true}).click();assert(!(await downloadEvent).suggestedFilename().includes('-unverified'));
 await page.screenshot({path:path.join(report,'03-delivery.png'),fullPage:true});
 // Binding drift keeps old evidence but never reuses its delivery label.
 const changed=await repository.get(id);changed.reuseProposal.design.conditions.push('New deployment condition requires reacceptance');await repository.save(changed);
 assert.equal((await api('GET',`/api/migrations/${id}/reuse-acceptance`)).status,'STALE');exported=await app.inject({method:'GET',url:`/api/migrations/${id}/export`,headers:{authorization:`Bearer ${accessToken}`}});assert.equal(exported.headers['x-migration-acceptance'],'UNVERIFIED');
 await page.reload();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.getByRole('button',{name:'继续处理',exact:true}).click();await page.getByRole('navigation',{name:'迁移步骤'}).getByRole('button',{name:'下载结果',exact:true}).click();await expect(page.getByRole('region',{name:'交付检查'}).getByText('已失效',{exact:true})).toBeVisible();
 const staleDownload=page.waitForEvent('download');await page.getByRole('button',{name:'下载迁移包',exact:true}).click();assert((await staleDownload).suggestedFilename().includes('-unverified'));await page.screenshot({path:path.join(report,'04-stale.png'),fullPage:true});
 // Independent authored design requiring a genuinely unsupported lifecycle primitive.
 const blocked=structuredClone(changed),blockedId='migration-'+randomUUID();blocked.id=blockedId;blocked.name='复用验收 · 部署切换应阻断';blocked.runs=[];blocked.suiteIds=[];delete blocked.reuseAcceptancePlan;delete blocked.reuseAcceptanceResults;blocked.technicalValidations=[];
 blocked.reuseProposal.design.scope='Skill can be reused after deploying a new Launcher';blocked.reuseProposal.design.conditions=['Must redeploy Launcher, not merely create a Runtime instance'];blocked.reuseProposal.design.acceptanceChecks=[{id:'redeploy',purpose:'Actual new deployment',procedure:'Deploy a fresh Launcher with this same candidate and rerun the Skill; compare deployment identity.',expectedResult:'A different Launcher deployment runs the same Skill correctly.'}];await repository.save(blocked);
 await page.reload();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.locator('.migration-project').filter({hasText:blocked.name}).getByRole('button',{name:'继续处理',exact:true}).click();await page.getByRole('navigation',{name:'迁移步骤'}).getByRole('button',{name:'验证能否运行',exact:true}).click();
 const blockedSection=page.getByRole('region',{name:'复用验收'});await blockedSection.getByLabel('复用验收 Runtime',{exact:true}).selectOption(environment.environmentId);await blockedSection.getByLabel('复用验收执行模型',{exact:true}).selectOption(info.modelId);
 const blockedPlan={name:'Deployment check',groups:[{id:'new-instance',cases:[{id:'redeploy-case',input:'Run the Skill after deployment',criteria:['Actual Launcher deployment identity differs']}]}],checks:[{checkId:'redeploy',caseIds:['redeploy-case'],criteria:['Must use a genuinely new Launcher deployment, not just instanceId']}],unresolvedQuestions:[]};
 await blockedSection.getByText('编辑验收计划（可选）',{exact:true}).click();await blockedSection.getByLabel('验收计划 JSON').fill(JSON.stringify(blockedPlan));
 const blockedResponse=page.waitForResponse(r=>r.url().endsWith('/reuse-acceptance/plan')&&r.request().method()==='POST',{timeout:900000});await blockedSection.getByRole('button',{name:'检查并保存计划',exact:true}).click();const blockedReply=await blockedResponse;assert.equal(blockedReply.status(),200,await blockedReply.text());const blockedSummary=await api('GET',`/api/migrations/${blockedId}/reuse-acceptance`);
 assert.equal(blockedSummary.plan.coverage.status,'INCOMPLETE');assert.equal(blockedSummary.result,null);await expect(blockedSection.getByRole('button',{name:'确认验收计划',exact:true})).toBeDisabled();await expect(blockedSection.getByText('计划还不能覆盖全部要求',{exact:true})).toBeVisible();
 const blockedStart=await app.inject({method:'POST',url:`/api/migrations/${blockedId}/reuse-acceptance/start`,headers:{authorization:`Bearer ${accessToken}`},payload:{planId:blockedSummary.plan.planId,inputDigest:blockedSummary.plan.inputDigest}});assert.equal(blockedStart.statusCode,409);
 await writeFile(path.join(report,'blocked.json'),JSON.stringify(blockedSummary,null,2));await page.screenshot({path:path.join(report,'05-blocked.png'),fullPage:true});assert.deepEqual(browserErrors,[]);
 console.log(JSON.stringify({report,mode:'AUTHORED_PORTABLE_FIXTURE_REAL_UI_COVERAGE_RUNTIME_AND_JUDGE',planSource,checks:summary.result.checks.map(c=>({id:c.checkId,status:c.status})),cases:jobs.reduce((n,j)=>n+j.report.cases.length,0)}));
}catch(error){await page?.screenshot({path:path.join(report,'failure.png'),fullPage:true}).catch(()=>{});
 if(app&&activeProjectId){const snapshot=await app.inject({method:'GET',url:`/api/migrations/${activeProjectId}/report`,headers:{authorization:'Bearer private-reuse-acceptance-test'}}).catch(()=>null);if(snapshot?.statusCode===200)await writeFile(path.join(report,'failure-report.json'),snapshot.body);}
 console.error(`Acceptance evidence: ${report}`);throw error}
finally{await browser?.close();await app?.close();for(const child of children)if(child.exitCode===null)await new Promise(r=>{const kill=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});kill.once('exit',r);kill.once('error',r)});await new Promise(r=>relay?relay.close(r):r());globalThis.fetch=originalFetch;await modelDispatcher.close();const privateLauncherToken=process.env.REUSE_UI_LAUNCHER_TOKEN;delete process.env.REUSE_UI_LAUNCHER_TOKEN;
 await writeFile(path.join(report,'launcher-error.log'),launcherError.replaceAll(privateLauncherToken??'[UNSET]','[REDACTED]').replaceAll(model.apiKey,'[REDACTED]').replaceAll('acceptance-private-binding','[REDACTED]'));
 // This exact temporary workspace is owned by the test; never delete user data.
 assert.equal(path.dirname(work),path.resolve(os.tmpdir()));assert(path.basename(work).startsWith('reuse-acceptance-ui-'));await rm(work,{recursive:true,force:true});}
