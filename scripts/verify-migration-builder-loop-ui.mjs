import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,cp,readFile,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {parse as parseYaml} from 'yaml';
import {chromium,expect} from '@playwright/test';
import {SkillStore} from '../dist/service/skill-store.js';
import {EnvironmentStore} from '../dist/service/environment-store.js';
import {MigrationProjectRepository} from '../dist/migration/infrastructure/migration-project-repository.js';
import {createEvaluationService} from '../dist/service/server.js';
import {configuredModelRole} from '../dist/service/config.js';

// Real model + real Builder UI round trip. Only fixture preparation is administrative:
// the deployed baseline deliberately permits only 2 iterations; verified execution
// failures must drive the Harness requirement without rewriting the Skill source.
// No fake model, fake execution, fake evaluation result or rewritten business Tool is used.
for(const key of ['MIGRATION_TEST_RESUME_DATA','MIGRATION_TEST_BUILDER_ROOT','MIGRATION_TEST_BUILDER_STATE','MIGRATION_TEST_BUILDER_PYTHON','MIGRATION_TEST_CODEX_BIN','MIGRATION_TEST_BUILDER_MODEL_NAME'])assert(process.env[key],`Missing ${key}`);
// Test-only opt-in for installations without a separate optimizer configuration.
// Never edit .env or silently change the production model-role mapping.
if(process.env.MIGRATION_TEST_OPTIMIZER_ROLE==='MIGRATION')for(const suffix of ['BASE_URL','API_KEY','MODEL','PROVIDER','REQUEST_DEFAULTS','TIMEOUT_MS']){
  const value=process.env[`FINANCE_EVAL_MIGRATION_${suffix}`];
  if(value!==undefined)process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`]=value;else delete process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`];
}
assert(configuredModelRole('OPTIMIZER').adapter);
const resumeOnly=!!process.env.MIGRATION_TEST_CONTINUE_DATA;
const data=resumeOnly?path.resolve(process.env.MIGRATION_TEST_CONTINUE_DATA):await mkdtemp(path.join(os.tmpdir(),'migration-builder-loop-ui-'));
if(!resumeOnly)await cp(path.resolve(process.env.MIGRATION_TEST_RESUME_DATA),data,{recursive:true});
const projects=new MigrationProjectRepository(data),skills=new SkillStore(data),[project]=await projects.list();assert(project?.candidate);
const originalCandidate=project.candidate;
if(resumeOnly){
  const pending=project.improvementTasks?.at(-1);
  assert(pending?.status==='WAITING_BUILDER'&&!pending.finalConsumed,'Only an unconsumed waiting task can continue');
  assert.equal(pending.bestCandidate.artifactSha256,originalCandidate.artifactSha256,'This fixture preserves the original Skill/Tools');
}
// Discover the Harness gap from actual failed execution/budget evidence. Never
// append a host requirement to a source after its diagnosis/design/generation,
// rewrite source identity, or erase historical outcomes to manufacture the gap.
const builderRoot=path.resolve(process.env.MIGRATION_TEST_BUILDER_ROOT),state=path.resolve(process.env.MIGRATION_TEST_BUILDER_STATE);
const sourceFile=path.join(data,'builder-source.json');await writeFile(sourceFile,JSON.stringify({assetId:originalCandidate.assetId,artifactSha256:originalCandidate.artifactSha256}),{mode:0o600});
const child=spawn('uv',['run','--extra','test','python','engineering/verify_eval_runtime_construction.py',
  '--state-root',state,'--python',process.env.MIGRATION_TEST_BUILDER_PYTHON,'--codex',process.env.MIGRATION_TEST_CODEX_BIN,
  '--input-rate','0','--output-rate','0','--model-name',process.env.MIGRATION_TEST_BUILDER_MODEL_NAME,
  '--await-eval-request','--source-file',sourceFile,'--baseline-port','18323','--release-port','18324','--serve'],
  {cwd:builderRoot,windowsHide:true,env:{...process.env,PYTHONPATH:`src;../base/src;.;tests`},stdio:['ignore','pipe','pipe']});
let childDone=false;const childExit=new Promise(resolve=>child.on('exit',code=>{childDone=true;resolve(code)}));
child.stdout.on('data',chunk=>{for(const line of chunk.toString().split('\n'))if(/^(BASELINE_|PASSED:|\{"stage":|\{"status":)/u.test(line))process.stderr.write(`builder ${line}\n`)});
// The backend emits only exception type and worker-local frame identifiers here.
// Do not forward other child logs (provider errors may contain private data).
let diagnosticTail='';
child.stderr.on('data',chunk=>{
  diagnosticTail+=chunk.toString();const lines=diagnosticTail.split('\n');diagnosticTail=lines.pop()??'';
  if(diagnosticTail.length>8192)diagnosticTail='';
  for(const line of lines){const match=line.match(/Package worker failed: (\{.*\})$/u);if(match)process.stderr.write(`builder worker diagnostic: ${match[1]}\n`)}
});
async function waitFile(name,timeout=900_000){await expect.poll(async()=>{if(childDone)throw new Error('Builder process stopped before delivery');return !!(await readFile(path.join(state,name)).catch(()=>null))},{timeout,intervals:[500,2000]}).toBe(true);return JSON.parse(await readFile(path.join(state,name),'utf8'))}
const checks=[],pass=message=>{checks.push(message);process.stderr.write(`ok ${message}\n`)};
const token='private-builder-loop-ui-test',STEP=1_800_000;let app,browser,page;
try{
  const baseline=await waitFile('baseline-connection-info.json');process.env.BUILDER_UI_BASELINE_CREDENTIAL=baseline.token;
  const trust=[{reference:'builder-baseline',label:'Baseline fixture',baseUrlPrefix:'http://127.0.0.1:18323/oj/',credentialEnv:'BUILDER_UI_BASELINE_CREDENTIAL'},
    {reference:'builder-release',label:'Construction release',baseUrlPrefix:'http://127.0.0.1:18324/oj/',credentialEnv:'BUILDER_UI_RELEASE_CREDENTIAL'}];
  const environments=new EnvironmentStore(data,trust);await environments.initialize();
  const baselineResult=JSON.parse(await readFile(path.join(state,'baseline-result.json'),'utf8'));
  const baselineName=`E2E Broken Harness ${baselineResult.launcher.deploymentId}`;
  if(!resumeOnly){
    const admitted=await environments.acceptBuilderDelivery({requirements:JSON.parse(await readFile(path.join(state,'baseline-requirements.json'),'utf8')),
      result:baselineResult,trustReference:'builder-baseline',name:baselineName});
    assert(admitted.environment.delivery);pass('real_baseline_launcher_protocol_conformance');
  }
  process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS='1';
  app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:data,publicDirectory:path.resolve('web-dist'),accessToken:token,publicDemo:false,launcherTrust:trust});
  const api=async(url,method='GET',payload)=>{const response=await app.inject({method,url,headers:{authorization:`Bearer ${token}`},...(payload?{payload}:{})});assert.equal(response.statusCode,200,`HTTP ${response.statusCode}`);return response.json()};
  browser=await chromium.launch({headless:true});page=await browser.newPage({acceptDownloads:true,viewport:{width:1440,height:1100}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(await app.listen({host:'127.0.0.1',port:0}));
  await page.getByLabel('访问令牌').fill(token);await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.getByRole('button',{name:'旧版任务记录',exact:true}).click();await page.getByRole('button',{name:'继续处理',exact:true}).click();
  const nav=page.getByRole('navigation',{name:'迁移步骤'});
  let task,workbench;
  if(!resumeOnly){
  await expect(nav.getByRole('button',{name:/验证能否运行/})).toBeEnabled({timeout:STEP});
  await nav.getByRole('button',{name:/验证能否运行/}).click();
  for(const name of ['calculate_acceptance_total','get_acceptance_order']){
    const card=page.locator('article').filter({has:page.getByRole('heading',{name,exact:true})});
    await card.getByText('高级设置：覆盖自动测试参数',{exact:true}).click();await card.locator('textarea').fill(JSON.stringify(name==='calculate_acceptance_total'?{subtotal:'100.00',tax_rate:'0.06'}:{order_id:'ORDER-001'}));
    const response=page.waitForResponse(r=>r.url().endsWith('/validate/technical')&&r.request().method()==='POST',{timeout:STEP});void response.catch(()=>{});
    await card.getByRole('button',{name:'开始试运行',exact:true}).click();assert.equal((await (await response).json()).status,'PASSED');
  }
  await nav.getByRole('button',{name:/验证实际效果/}).click();await page.getByRole('button',{name:/提供测试集和目标/}).click();
  await page.getByLabel('准备方式').selectOption('import');await page.getByLabel('预览或编辑测试集').fill(JSON.stringify({name:'原生循环能力验收',cases:[
    {id:'dev-order',input:'按 Skill 流程查询 ORDER-001 并计算税额和合计。必须读取规则、查询订单、调用计算工具再回答。',criteria:['真实查询及计算工具均完成；回答 ORDER-001、CNY、小计100.00、税额6.00、合计106.00。']},
    {id:'dev-missing',input:'按 Skill 流程查询 ORDER-NOT-FOUND，说明是否可以结算。',criteria:['真实查询订单后报告不可用，不编造金额，不调用计算工具。']},
  ],holdoutCases:[{id:'sealed-order',input:'按 Skill 流程查询 ORDER-002 并给出税额及合计，必须调用工具。',criteria:['真实查询及计算工具均完成；回答 ORDER-002、CNY、小计250.00、税额32.50、合计282.50。']}]}));
  await page.getByRole('button',{name:'确认并导入',exact:true}).click();await expect(page.locator('.assessment-config-grid select').first().locator('option')).toHaveCount(2,{timeout:STEP});
  await page.locator('.assessment-config-grid select').nth(1).selectOption({label:baselineName});
  await page.getByRole('button',{name:'执行并自动评估',exact:true}).click();
  await expect.poll(async()=>{const report=await api(`/api/migrations/${project.id}/report`);return report.experiments.at(-1)?.execution},{timeout:STEP,intervals:[2000,5000]}).toBe('completed');
  const before=await api(`/api/migrations/${project.id}/report`);assert.notEqual(before.experiments.at(-1).acceptance.status,'PASSED');
  assert(before.experiments.at(-1).report.cases.some(item=>item.right.error?.includes('EVAL_PACKAGE_ITERATION_LIMIT')));
  assert(before.experiments.at(-1).report.cases.every(item=>!item.right.error?.includes('INSTANCE_NOT_FOUND')));
  pass('real_native_loop_limit_reproduced_through_ui');
  workbench=page.getByRole('region',{name:'持续改进任务'});
  const started=page.waitForResponse(r=>r.url().endsWith('/improvement-tasks')&&r.request().method()==='POST',{timeout:30_000});void started.catch(()=>{});
  await workbench.getByRole('button',{name:'开始持续改进',exact:true}).click();assert.equal((await started).status(),200,'Improvement task start was rejected');
  await expect.poll(async()=>{const tasks=await api(`/api/migrations/${project.id}/improvement-tasks`);return tasks.at(-1)?.status??'RUNNING'},{timeout:STEP,intervals:[2000,5000]}).not.toBe('RUNNING');
  }
  task=(await api(`/api/migrations/${project.id}/improvement-tasks`)).at(-1);assert.equal(task.status,'WAITING_BUILDER',task.reason);assert(task.runtimeRequirements);
  assert.equal(task.finalConsumed,false,'Never replay a consumed holdout');
  assert(task.iterations.every(item=>item.layer==='HARNESS'));assert.equal((await projects.get(project.id)).candidate.assetId,originalCandidate.assetId);
  pass('real_planner_requests_harness_without_rewriting_business_tools');
  await nav.getByRole('button',{name:/Runtime 适配与登记/}).click();
  await expect(page.getByRole('button',{name:'下载能力需求 YAML',exact:true})).toBeVisible({timeout:30_000});
  const download=page.waitForEvent('download',{timeout:60_000});void download.catch(()=>{});
  const requirementsResponse=page.waitForResponse(r=>r.url().endsWith('/runtime-requirements.yaml'),{timeout:30_000});void requirementsResponse.catch(()=>{});
  await page.getByRole('button',{name:'下载能力需求 YAML',exact:true}).click();assert.equal((await requirementsResponse).status(),200,'Requirements download rejected');
  const yamlFile=path.join(data,'downloaded-runtime-request.yaml');await (await download).saveAs(yamlFile);
  const requirement=parseYaml(await readFile(yamlFile,'utf8'));assert.equal(requirement.requirementsDigest,task.runtimeRequirements.requirementsDigest);
  await writeFile(path.join(state,'request.json'),JSON.stringify(requirement),{mode:0o600});
  const release=await waitFile('connection-info.json',STEP);process.env.BUILDER_UI_RELEASE_CREDENTIAL=release.token;
  const result=JSON.parse(await readFile(path.join(state,'result.json'),'utf8'));assert.equal(result.status,'SUCCEEDED');
  await page.getByLabel('Builder Result JSON').setInputFiles(path.join(state,'result.json'));await page.getByLabel('Launcher 信任配置').selectOption('builder-release');
  const accepted=page.waitForResponse(r=>r.url().endsWith('/runtime-deliveries')&&r.request().method()==='POST',{timeout:STEP});void accepted.catch(()=>{});
  await page.getByRole('button',{name:'验收并登记 Launcher',exact:true}).click();assert.equal((await accepted).status(),200);
  await expect(page.getByText('Builder Launcher 已验收并登记',{exact:true})).toBeVisible({timeout:30_000});
  pass('ui_download_real_construction_new_artifact_and_delivery_conformance');
  await nav.getByRole('button',{name:/验证实际效果/}).click();workbench=page.getByRole('region',{name:'持续改进任务'});
  const resumed=page.waitForResponse(r=>r.url().endsWith('/resume')&&r.request().method()==='POST',{timeout:30_000});void resumed.catch(()=>{});
  await workbench.getByRole('button',{name:'使用所选 Runtime 继续',exact:true}).click();
  assert.equal((await resumed).status(),200);
  await expect.poll(async()=>{const tasks=await api(`/api/migrations/${project.id}/improvement-tasks`);return tasks.at(-1)?.status??'RUNNING'},{timeout:STEP,intervals:[2000,5000]}).not.toBe('RUNNING');
  task=(await api(`/api/migrations/${project.id}/improvement-tasks`)).at(-1);assert.equal(task.status,'REVIEW',task.reason);assert(task.finalVerified);
  await workbench.getByRole('button',{name:'采用已通过复核的候选',exact:true}).click();
  await expect(workbench.getByText('已采用',{exact:true}).first()).toBeVisible({timeout:30_000});
  const after=await projects.get(project.id);assert.equal(after.candidate.artifactSha256,originalCandidate.artifactSha256);assert.equal(after.runtimeDelivery.artifactSha256,result.launcher.artifactSha256);
  assert.deepEqual(errors,[]);pass('same_skill_tools_frozen_tests_new_harness_verified_and_adopted');
  await mkdir(path.resolve('reports/migration-builder-loop-ui'),{recursive:true});await page.screenshot({path:path.resolve('reports/migration-builder-loop-ui/success.png'),fullPage:true});
  process.stdout.write(JSON.stringify({mode:'REAL_BUILDER_ROUND_TRIP',checks,taskId:task.taskId,finalJobId:task.finalJobId})+'\n');
}catch(error){process.stderr.write(String(error)+'\n');await mkdir(path.resolve('reports/migration-builder-loop-ui'),{recursive:true});await page?.screenshot({path:path.resolve('reports/migration-builder-loop-ui/failure.png')}).catch(()=>{});throw error;}
finally{await browser?.close();await app?.close();await writeFile(path.join(state,'stop'),'stop').catch(()=>{});await childExit;
  delete process.env.BUILDER_UI_BASELINE_CREDENTIAL;delete process.env.BUILDER_UI_RELEASE_CREDENTIAL;process.stderr.write(`Retained private acceptance data: ${data}\n`);}
