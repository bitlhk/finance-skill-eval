import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {chromium,expect} from '@playwright/test';
import {SkillStore} from '../dist/service/skill-store.js';
import {MigrationProjectRepository} from '../dist/migration/infrastructure/migration-project-repository.js';
import {createEvaluationService} from '../dist/service/server.js';
import {configuredModelRole} from '../dist/service/config.js';

// Opt-in real acceptance only. Retained migration data contains a previously real-model
// generated Skill/MCP/Script package. Clone it and inject a controlled calculation defect;
// never alter the original package, production records, test answers or evaluation results.
assert(process.env.MIGRATION_TEST_RESUME_DATA&&process.env.MIGRATION_TEST_LAUNCHER_INFO,
  'Requires private retained real migration data and live Builder connection info');
// Explicit test-process role mapping only; never write secrets or silently change production roles.
const optimizerRole=process.env.MIGRATION_TEST_OPTIMIZER_ROLE;
if(optimizerRole){
  assert(['ANALYZER','MIGRATION','JUDGE'].includes(optimizerRole));
  for(const suffix of ['BASE_URL','API_KEY','MODEL','PROVIDER','REQUEST_DEFAULTS','TIMEOUT_MS']){
    const value=process.env[`FINANCE_EVAL_${optimizerRole}_${suffix}`];
    if(value!==undefined)process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`]=value;
    else delete process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`];
  }
}
assert(configuredModelRole('OPTIMIZER').adapter,'Configure real OPTIMIZER or explicitly choose MIGRATION_TEST_OPTIMIZER_ROLE');
const continued=process.env.MIGRATION_TEST_CONTINUE_DATA;
const repairLayer=process.env.MIGRATION_TEST_REPAIR_LAYER??'TOOL';
assert(['TOOL','SKILL'].includes(repairLayer),'Supported real fault scenarios: TOOL, SKILL');
assert(!continued||repairLayer==='TOOL','Skill scenario must start with an unused independent run');
const reportDirectory=path.resolve(`reports/migration-improvement-ui-${repairLayer.toLowerCase()}-${Date.now()}`);
const data=continued?path.resolve(continued):await mkdtemp(path.join(os.tmpdir(),'migration-improvement-ui-'));
if(!continued)await cp(path.resolve(process.env.MIGRATION_TEST_RESUME_DATA),data,{recursive:true});
const skills=new SkillStore(data),projects=new MigrationProjectRepository(data);
const [project]=await projects.list();assert(project?.candidate);
let candidate=project.candidate;
if(!continued){
const old=project.candidate,files=await skills.readArchive(old.assetId);
if(repairLayer==='TOOL'){
 const calculator=project.inspection.tools.find(tool=>tool.name==='calculate_acceptance_total');assert(calculator);
 const entry=calculator.entrypoint.path,original=Buffer.from(files[entry]).toString();
 assert(original.includes('(amount * rate).quantize('));
 files[entry]=strToU8(original.replace('(amount * rate).quantize(','(amount * rate * Decimal("2")).quantize('));
}else{
 const original=Buffer.from(files[old.skillFile]).toString();
 assert(original.includes('## Final output')&&original.includes('## Execution notes'));
 files[old.skillFile]=strToU8(original.replace(/## Final output[\s\S]*?(?=## Execution notes)/u,
   '## Final output\n\nReturn the order ID, subtotal, tax amount and total. Omit the currency from the final answer even when the lookup tool returns it. Never include the currency code or currency name in the final response.\n\n'));
}
candidate=await skills.uploadZip(Buffer.from(zipSync(files)),{version:`${old.version}-fault-acceptance`});
project.candidate=candidate;project.inspection.assetId=candidate.assetId;project.inspection.assetDigest=candidate.artifactSha256;
project.decisions.push(...project.decisions.filter(item=>item.baseAssetId===old.assetId).map(item=>({...item,baseAssetId:candidate.assetId})));
project.candidateHistory.push({asset:candidate,notes:'Explicit synthetic fault injection for real optimization acceptance',kind:'migration',recordedAt:new Date().toISOString()});
project.technicalValidations=[];project.runs=[];project.suiteIds=[];project.improvementTasks=[];project.improvementPlans=[];project.toolOptimizationAttempts=[];
await projects.save(project);
}else{
  assert(candidate.version.endsWith('-fault-acceptance'),'Only resume the synthetic fault fixture before adoption');
  assert(!project.improvementTasks?.some(task=>task.finalConsumed||task.status==='RUNNING'),'Do not reuse a consumed holdout or an active task');
}
const info=JSON.parse(await readFile(process.env.MIGRATION_TEST_LAUNCHER_INFO,'utf8'));assert.equal(info.status,'READY');
process.env.MIGRATION_IMPROVEMENT_CREDENTIAL=info.token;process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS='1';
const token='private-improvement-ui-test';
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:data,publicDirectory:path.resolve('web-dist'),accessToken:token,publicDemo:false});
app.log.level='error';
const api=async(url,method='GET',payload)=>{const response=await app.inject({method,url,headers:{authorization:`Bearer ${token}`},...(payload?{payload}:{})});assert.equal(response.statusCode,200,`HTTP ${response.statusCode}: ${response.body.slice(0,400)}`);return response.json()};
const catalog=await api('/api/catalog'),registration=catalog.environments.find(item=>item.name==='E2E Runtime');assert(registration);
await api(`/api/environments/${registration.environmentId}`,'PUT',{name:'E2E Runtime',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:info.baseUrl,credentialEnv:'MIGRATION_IMPROVEMENT_CREDENTIAL'});
const checks=[];const pass=message=>{checks.push(message);process.stderr.write(`ok ${message}\n`)};
const STEP=900_000;let browser,page;
try{
  const url=await app.listen({host:'127.0.0.1',port:0});browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1440,height:1100}});const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url);await page.getByLabel('访问令牌').fill(token);await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.getByRole('button',{name:'继续处理',exact:true}).click();
  const nav=page.getByRole('navigation',{name:'迁移步骤'});
  if(!continued){
  await nav.getByRole('button',{name:/验证能否运行/}).click();
  for(const name of ['calculate_acceptance_total','get_acceptance_order']){
    const card=page.locator('article').filter({has:page.getByRole('heading',{name,exact:true})});
    await card.getByText('高级设置：覆盖自动测试参数',{exact:true}).click();
    await card.locator('textarea').fill(JSON.stringify(name==='calculate_acceptance_total'?{subtotal:'100.00',tax_rate:'0.06'}:{order_id:'ORDER-001'}));
    const response=page.waitForResponse(r=>r.url().endsWith('/validate/technical')&&r.request().method()==='POST',{timeout:STEP});void response.catch(()=>{});
    await card.getByRole('button',{name:'开始试运行',exact:true}).click();const validation=await (await response).json();assert.equal(validation.status,'PASSED');
  }
  pass('fault_candidate_real_technical_checks_not_business_acceptance');
  await nav.getByRole('button',{name:/验证实际效果/}).click();
  await page.getByRole('button',{name:/提供测试集和目标/}).click();
  await page.getByLabel('准备方式').selectOption('import');
  const suite={name:'独立工具缺陷修复验收',cases:[
    {id:'dev-approved',input:'请按 Skill 流程查询 ORDER-001 并计算税额和合计。必须调用查询工具及计算工具，基于实际计算工具结果回答，不要在回答里另算一个值来掩盖工具错误。',criteria:[
      '必须真实调用 get_acceptance_order 和 calculate_acceptance_total；计算工具实际返回 tax_amount=6.00、total=106.00。工具返回错误值，仅在文字中纠正不算通过。',
      '最终回答正文必须明确包含币种 CNY。币种只出现在工具结果、而未出现在最终回答中不算通过，应判 FAIL。',
      '最终回答包含 ORDER-001、小计100.00、税额6.00、合计106.00。']},
    {id:'dev-unavailable',input:'查询 ORDER-NOT-FOUND 并告知是否可以结算。',criteria:['必须查询该订单，说明订单不可用；不得计算或编造金额。']},
  ],holdoutCases:[{id:'sealed-approved',input:'请查询 ORDER-002，按 Skill 的工具流程计算税额和合计，以工具实际结果回答。',criteria:[
    '实际查询并计算 ORDER-002；计算工具 tax_amount 为32.50，total 为282.50。不得绕过工具另算答案。',
    '最终回答正文必须明确包含币种 CNY。币种只出现在工具结果、而未出现在最终回答中不算通过，应判 FAIL。',
    '回答包含 ORDER-002、小计250.00、税額32.50、合计282.50。']}]};
  await page.getByLabel('预览或编辑测试集').fill(JSON.stringify(suite));await page.getByRole('button',{name:'确认并导入',exact:true}).click();
  await expect(page.locator('.assessment-config-grid select').first().locator('option')).toHaveCount(2,{timeout:STEP});
  await page.locator('.assessment-config-grid select').nth(1).selectOption({label:'E2E Runtime'});
  const started=page.waitForResponse(r=>r.url().endsWith('/validate/openjiuwen')&&r.request().method()==='POST',{timeout:STEP});
  await page.getByRole('button',{name:'执行并自动评估',exact:true}).click();assert.equal((await started).status(),200);
  await expect(page.locator('.assessment-results .migration-result').first().locator(':scope > summary .stage-badge')).toContainText('已完成',{timeout:STEP});
  const baseline=await api(`/api/migrations/${project.id}/report`),baselineJob=baseline.experiments.at(-1);
  assert.equal(baselineJob.acceptance.status,'FAILED','Injected defect must be detected by real execution and Judge');
  assert(baselineJob.report.cases.some(c=>c.caseId==='dev-unavailable'&&c.judge.goalAssessment.verdict==='PASS'));
  if(repairLayer==='SKILL')assert(!baselineJob.report.cases.find(c=>c.caseId==='dev-approved').right.output.includes('CNY'),'The isolated document defect was not reproduced');
  pass('real_baseline_rejects_injected_tool_defect_preserves_negative_case');
  }else{
    await nav.getByRole('button',{name:/验证实际效果/}).click();
    pass('resumed_unmodified_failed_baseline_and_unconsumed_holdout');
  }
  const workbench=page.getByRole('region',{name:'持续改进任务'});
  await workbench.getByRole('button',{name:'开始持续改进',exact:true}).click();
  await expect.poll(async()=>{const tasks=await api(`/api/migrations/${project.id}/improvement-tasks`);return tasks.at(-1)?.status??'RUNNING'},
    {timeout:STEP,intervals:[2000,5000]}).not.toBe('RUNNING');
  const task=(await api(`/api/migrations/${project.id}/improvement-tasks`)).at(-1);assert.equal(task.status,'REVIEW',task.reason);assert(task.finalVerified);
  await expect(workbench.getByRole('button',{name:'采用已通过复核的候选',exact:true})).toBeVisible({timeout:30_000});
  assert(task.iterations.some(item=>item.layer===repairLayer&&item.outcome==='PROMOTED'));
  assert(task.iterations.every(item=>item.layer===repairLayer),'The controlled defect must be repaired at its actual layer');
  if(repairLayer==='SKILL'){
    const before=await skills.readArchive(candidate.assetId),after=await skills.readArchive(task.bestCandidate.assetId);
    const isTool=name=>!name.endsWith('.md');
    assert.deepEqual(Object.keys(after).filter(isTool).sort(),Object.keys(before).filter(isTool).sort());
    for(const name of Object.keys(before).filter(isTool))assert.deepEqual(Buffer.from(after[name]),Buffer.from(before[name]),`Unexpected Tool/asset change: ${name}`);
  }
  assert.equal((await projects.get(project.id)).candidate.assetId,candidate.assetId);
  pass(`real_planner_${repairLayer.toLowerCase()}_repair_frozen_dev_and_single_holdout_passed`);
  await workbench.getByRole('button',{name:'采用已通过复核的候选',exact:true}).click();
  await expect(workbench.getByText('已采用',{exact:true}).first()).toBeVisible({timeout:STEP});
  assert.equal((await projects.get(project.id)).candidate.assetId,task.bestCandidate.assetId);
  const report=await api(`/api/migrations/${project.id}/report`);assert.equal(report.experiments.find(item=>item.jobId===task.finalJobId).acceptance.status,'PASSED');
  assert.deepEqual(errors,[]);pass('explicit_ui_adoption_and_final_report_consistent');
  await mkdir(reportDirectory,{recursive:true});await page.screenshot({path:path.join(reportDirectory,'success.png'),fullPage:true});
  process.stdout.write(JSON.stringify({mode:'REAL_MODELS_AND_CONSTRUCTED_LAUNCHER',repairLayer,checks,taskId:task.taskId,iterations:task.iterations,finalJobId:task.finalJobId})+'\n');
}catch(error){process.stderr.write(String(error)+'\n');await mkdir(reportDirectory,{recursive:true});await page?.screenshot({path:path.join(reportDirectory,'failure.png')}).catch(()=>{});throw error;}
finally{await browser?.close();await app.close();delete process.env.MIGRATION_IMPROVEMENT_CREDENTIAL;process.stderr.write(`Retained private acceptance data: ${data}\n`);}
