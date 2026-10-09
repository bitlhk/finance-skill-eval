import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createEvaluationService} from '../dist/service/server.js';
import {SkillStore} from '../dist/service/skill-store.js';
import {MigrationProjectRepository} from '../dist/migration/infrastructure/migration-project-repository.js';
import {zipSync,strToU8} from 'fflate';

// Real-model diagnosis and execution over an isolated copy of a previously generated
// migration. Never edit model results or the original retained project to force reuse.
assert(process.env.MIGRATION_TEST_RESUME_DATA&&process.env.MIGRATION_TEST_LAUNCHER_INFO);
const info=JSON.parse(await readFile(process.env.MIGRATION_TEST_LAUNCHER_INFO,'utf8'));
assert.equal(info.status,'READY');
const data=await mkdtemp(path.join(os.tmpdir(),'runtime-reuse-ui-'));
await cp(process.env.MIGRATION_TEST_RESUME_DATA,data,{recursive:true});
const reuseDiagnosis=process.env.MIGRATION_TEST_REUSE_DIAGNOSIS==='true';
const projectsStore=new MigrationProjectRepository(data),fixtureProject=(await projectsStore.list())[0];assert(fixtureProject);
// Reset only the cloned UI selection so the reuse confirmation can be exercised again.
delete fixtureProject.runtimeReuse;
// Controlled source variant: the original fixture only says "Read references" and may
// legitimately need no dedicated native interface. This variant explicitly requires one.
// Only fixture input changes; A2 must independently inspect it. No diagnosis is patched.
if(!reuseDiagnosis){
const skills=new SkillStore(data);await skills.initialize();
const sourceFiles=await skills.readArchive(fixtureProject.source.assetId);
sourceFiles[fixtureProject.source.skillFile]=strToU8(Buffer.from(sourceFiles[fixtureProject.source.skillFile]).toString()+'\n## Native resource access requirement\nThe host must expose the model-callable read_file tool. Call it with path="references/acceptance-policy.md", scope="skill" before querying an order. The path is relative to the installed Skill document directory, never a host absolute path. The optional workspace scope is relative to this case only; it must not read a previous case workspace. Input has a required string path and optional scope (workspace or skill), no other arguments. Success returns path and UTF-8 content. Invalid, missing, non-UTF-8 or oversized files return status=unavailable and error=TOOL_EXECUTION_FAILED. Reject traversal and files over 256 KiB. This requirement does not grant host filesystem access or require an OS sandbox for business scripts.\n');
fixtureProject.source=await skills.uploadMigrationZip(Buffer.from(zipSync(sourceFiles)));
}
await projectsStore.save(fixtureProject);
const report=path.resolve(`reports/runtime-reuse-ui-${Date.now()}`);await mkdir(report,{recursive:true});
process.env.MIGRATION_UI_REUSE_TOKEN=info.token;process.env.FINANCE_EVAL_ALLOW_TRUSTED_LOCAL_SCRIPTS='true';
const token='private-reuse-ui-test';
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:data,accessToken:token,publicDemo:false});app.log.level='error';
const api=async(method,url,payload)=>{const response=await app.inject({method,url,headers:{authorization:`Bearer ${token}`},...(payload===undefined?{}:{payload})});assert.equal(response.statusCode,200,response.body.slice(0,400));return response.json();};
let browser,page;const checks=[];
try{
 const environment=await api('POST','/api/environments',{name:'Existing contract Runtime',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:info.baseUrl,credentialEnv:'MIGRATION_UI_REUSE_TOKEN'});
 const projects=await api('GET','/api/migrations');assert.equal(projects.length,1);const id=projects[0].id,base=`/api/migrations/${id}`;
 assert(projects[0].candidate,'Use the retained real generated candidate');
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
 page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(await app.listen({host:'127.0.0.1',port:0}));await page.getByLabel('访问令牌').fill(token);await page.getByRole('button',{name:'进入工作区',exact:true}).click();
 await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.getByRole('button',{name:'继续处理',exact:true}).click();
 const nav=page.getByRole('navigation',{name:'迁移步骤'});
 await nav.getByRole('button',{name:/Runtime 适配与登记/}).click();
 await page.getByLabel('已有 Runtime',{exact:true}).selectOption(environment.environmentId);
 if(!reuseDiagnosis){
  const inspected=page.waitForResponse(r=>r.url().endsWith('/inspect/source')&&r.request().method()==='POST',{timeout:900000});void inspected.catch(()=>{});
  await page.getByRole('button',{name:'结合此 Runtime 重新诊断',exact:true}).click();assert.equal((await inspected).status(),200);
 }
 const requirements=await api('GET',base+'/runtime-requirements');
 assert(requirements.requiredCapabilities?.some(c=>c.preferredTargetCapability==='package.read_file'),'Real diagnosis must retain the applicable read_file requirement with source evidence');
 checks.push(`${reuseDiagnosis?'retained_':'fresh_'}real_diagnosis_preserves_read_file_and_matches_advertised_contract`);
 const reused=page.waitForResponse(r=>r.url().endsWith('/runtime-reuse')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'核对并使用',exact:true}).click();assert.equal((await reused).status(),200);
 await expect(page.getByText('已有 Runtime 的能力合同已核对',{exact:true})).toBeVisible();
 const bound=await api('GET',base+'/report');assert.equal(bound.runtimeRequirements,null);assert(bound.runtimeReuse);assert.equal(bound.project.runtimeDelivery,undefined);
 checks.push('ui_reuses_existing_launcher_without_builder_result');
 await nav.getByRole('button',{name:'验证能否运行',exact:true}).click();
 for(const [name,input] of [['calculate_acceptance_total',{subtotal:'100.00',tax_rate:'0.06'}],['get_acceptance_order',{order_id:'ORDER-001'}]]){
  const card=page.locator('article').filter({hasText:name});await card.getByText('高级设置：覆盖自动测试参数',{exact:true}).click();await card.locator('textarea').fill(JSON.stringify(input));
  const validated=page.waitForResponse(r=>r.url().endsWith('/validate/technical')&&r.request().method()==='POST',{timeout:300000});void validated.catch(()=>{});
  await card.getByRole('button',{name:'开始试运行',exact:true}).click();assert.equal((await (await validated).json()).status,'PASSED');
 }
 await nav.getByRole('button',{name:'验证实际效果',exact:true}).click();await page.getByRole('button',{name:/提供测试集和目标/}).click();
 await page.getByLabel('准备方式').selectOption('import');
 await page.getByLabel('预览或编辑测试集').fill(JSON.stringify({name:'已有 Runtime 读取能力验收',cases:[
  {id:'order-001',input:'读取 Skill 的 references/acceptance-policy.md，查询 ORDER-001 并计算总额，报告订单号、币种、小计、税额、总额。',criteria:['实际调用订单查询和计算工具。','最终回答包含 ORDER-001、CNY、小计 100.00、税额 6.00、总额 106.00。']},
  {id:'order-002',input:'按 Skill 规则查询 ORDER-002 并计算总额，报告币种和金额。',criteria:['实际调用订单查询和计算工具。','最终回答包含 CNY、小计 250.00、税额 32.50、总额 282.50。']}
 ],holdoutCases:[]}));
 const imported=page.waitForResponse(r=>r.url().endsWith('/suites/import')&&r.request().method()==='POST');await page.getByRole('button',{name:'确认并导入',exact:true}).click();assert.equal((await imported).status(),200);
 await page.locator('.assessment-config-grid select').nth(1).selectOption(environment.environmentId);
 const evaluation=page.waitForResponse(r=>r.url().endsWith('/validate/openjiuwen')&&r.request().method()==='POST',{timeout:300000});void evaluation.catch(()=>{});
 await page.getByRole('button',{name:'执行并自动评估',exact:true}).click();const started=await evaluation;assert.equal(started.status(),200);const jobId=(await started.json()).job.jobId;
 await expect.poll(async()=>(await api('GET',`/api/runs/${jobId}`)).status,{timeout:900000,intervals:[2000]}).toMatch(/^(completed|failed|cancelled)$/u);
 const job=await api('GET',`/api/runs/${jobId}`);assert(job.report.cases.every(c=>c.judge?.goalAssessment?.verdict==='PASS'&&c.right.status==='completed'));
 await expect(page.getByText('最新 2/2 通过',{exact:true})).toBeVisible();
 assert(job.report.cases.some(c=>c.right.toolCalls.some(t=>t.name==='read_file'&&t.status==='completed')),'A real read_file call is required, not just a capabilities declaration');
 const evaluated=await api('GET',base+'/report'),revision=evaluated.project.runs.find(run=>run.jobId===jobId).solutionRevisions.right;
 assert.equal(revision.runtime.capabilitiesDigest,evaluated.runtimeReuse.capabilitiesDigest);
 assert.equal(revision.runtime.deploymentId,null);assert.equal(revision.runtime.artifactSha256,null);
 assert.equal(evaluated.experiments.find(run=>run.jobId===jobId).current,true);
 checks.push('run_revision_pins_verified_capabilities_without_inventing_builder_provenance');
 checks.push('real_read_file_mcp_script_and_judge_pass');
 await page.screenshot({path:path.join(report,'result.png'),fullPage:true});assert.deepEqual(errors,[]);
 await writeFile(path.join(report,'result.json'),JSON.stringify({mode:'REUSED_REAL_CANDIDATE_REAL_RUNTIME_AND_JUDGE',diagnosis:reuseDiagnosis?'REUSED_REAL':'FRESH_REAL',sourceVariant:'explicit_native_read_file',checks,jobId,cases:job.report.cases.map(c=>({id:c.caseId,verdict:c.judge.goalAssessment.verdict}))},null,2));
 console.log(JSON.stringify({checks,report}));
}catch(error){await page?.screenshot({path:path.join(report,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await browser?.close();await app.close();delete process.env.MIGRATION_UI_REUSE_TOKEN;console.error(`Retained private data: ${data}`);}
