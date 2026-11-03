import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {zipSync} from 'fflate';
import {createEvaluationService} from '../dist/service/server.js';
import {taskBuilderLauncher} from './lib/task-builder-test-launcher.mjs';

// Real UI/API/Runtime adapter and HTTP lifecycle; deterministic Agent/Judge/Launcher fixture.
const data=await mkdtemp(path.join(os.tmpdir(),'project-baseline-ui-'));
const host=await taskBuilderLauncher();host.caps.features.projectExecution=true;
host.caps.limits.maxTimeoutMs=240000;
let judgments=0,analyses=0,browser;
const token='project-baseline-test';
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:data,
  publicDirectory:path.join(process.cwd(),'web-dist'),accessToken:token,publicDemo:false,
  bundlePorts:{agent:async input=>{
    assert.equal(input.mode,'PREPARE');
    return {status:'PRODUCED',files:input.base.files,preparation:{summary:'Original project prepared',skills:[],
      entrypoints:['app/main.py'],missing:[],baselinePlan:'Run original business cases'}};
  },judge:async ({evidence})=>{judgments++;assert.equal(evidence.output,'BUSINESS_OK');return {passed:true,reason:'Expected business result'};},
  improvementAgents:()=>({diagnose:async input=>{analyses++;assert.equal(input.codeEvidence[0].path,'app/main.py');
    return {judgement:{status:'ABSTAINED',reason:'No demonstrated failure'},investigation:[]};},review:async()=>{throw Error('Unexpected optimization Review');}})}});
app.log.level='error';
try {
  const registration=await app.inject({method:'POST',url:'/api/environments',headers:{authorization:'Bearer '+token},
    payload:{name:'原工程测试环境',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:host.baseUrl}});
  assert.equal(registration.statusCode,200,registration.body);
  const url=await app.listen({host:'127.0.0.1',port:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url);await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
  await page.getByRole('button',{name:'新建迁移',exact:true}).click();
  await page.getByLabel('上传类型',{exact:true}).selectOption('agent_project');
  await page.locator('.bundle-panel input[type=file]').setInputFiles({name:'project.zip',mimeType:'application/zip',
    buffer:Buffer.from(zipSync({'app/main.py':Buffer.from('print("BUSINESS_OK")')}))});
  await expect(page.getByText('Original project prepared',{exact:true})).toBeVisible();
  await page.getByLabel('基线运行环境',{exact:true}).selectOption({label:'原工程测试环境'});
  await page.getByLabel('任务内容',{exact:true}).fill('Run a business case');
  await page.getByLabel('预期结果（每行一条）',{exact:true}).fill('Return BUSINESS_OK');
  await page.getByLabel('标准 1 的评判范围').selectOption('answer');
  await page.getByText('规则、脚本与状态检查（0 项）',{exact:true}).click();
  await page.getByRole('button',{name:'添加检查',exact:true}).click();
  await page.getByLabel('判断方法',{exact:true}).selectOption('contains');
  await page.getByLabel('期望值（JSON，例如 42、"成功" 或 ["A","B"]）',{exact:true}).fill('"BUSINESS_OK"');
  await page.getByLabel('业务运行次数',{exact:true}).selectOption('2');
  await page.getByLabel('确认此案例只读，不修改外部业务状态',{exact:true}).check();
  await page.getByRole('button',{name:'运行正式业务基线',exact:true}).click();
  await expect(page.getByText('当前准备版本已有完整业务基线。',{exact:true})).toBeVisible({timeout:15000});
  const response=await app.inject({url:'/api/migration-tasks',headers:{authorization:'Bearer '+token}});
  const task=response.json()[0],run=task.runs.at(-1);
  assert.equal(run.purpose,'baseline');assert.equal(run.status,'PASSED');assert.equal(task.currentBaselineRunId,run.id);
  assert.equal(run.configuration.timeoutMs,240000);
  assert.equal(task.currentCandidateId,null);assert.equal(task.verifiedRunId,undefined);
  assert.equal(task.preparations[0].baselineStatus,'PASSED');
  assert.equal(run.cases[0].evidence.metadata.projectExecution,true);
  assert.equal(judgments,2);assert.equal(host.instances.size,0);
  assert.equal(host.creations[0].executionMode,'agent_project');assert.deepEqual(host.creations[0].skills,[]);
  assert.deepEqual(Object.keys(host.creations[0].assets),['app/main.py']);
  assert.equal(run.suite.cases[0].criterionScopes[0],'answer');
  assert.equal(run.cases[0].methodResults.at(-1).status,'PASS');
  await page.getByLabel('重复评判次数',{exact:true}).last().selectOption('2');
  await page.getByRole('button',{name:'使用已保存证据重新评判',exact:true}).last().click();
  await expect(page.getByText(/重新评判 ·/)).toBeVisible();
  const rescored=(await app.inject({url:'/api/migration-tasks/'+task.id,headers:{authorization:'Bearer '+token}})).json();
  assert.equal(rescored.rescorings.length,1);
  assert.equal(rescored.runs.length,2);
  assert.equal(rescored.currentBaselineRunId,run.id);
  assert.equal(judgments,4);assert.equal(host.creations.length,2);
  assert.equal(rescored.rescorings[0].attempts.length,2);
  assert.equal(rescored.rescorings[0].stability[0].agreement,1);
  await page.getByRole('button',{name:'分析本次评测问题',exact:true}).last().click();
  await expect(page.getByText(/问题分析 ·/)).toBeVisible();
  const analyzed=(await app.inject({url:'/api/migration-tasks/'+task.id,headers:{authorization:'Bearer '+token}})).json();
  assert.equal(analyses,1);assert.equal(analyzed.runAnalyses.length,1);assert.equal(host.creations.length,2);
  assert.equal(analyzed.currentBaselineRunId,run.id);
  await page.getByText('人工标注与 Judge 校准',{exact:true}).last().click();
  await page.getByRole('button',{name:'加载人工复核',exact:true}).last().click();
  await page.getByLabel('标注者名称',{exact:true}).fill('reviewer-a');
  await page.getByLabel('人工结论',{exact:true}).selectOption('PASS');
  await page.getByLabel('复核理由',{exact:true}).fill('Observed BUSINESS_OK');
  await page.getByLabel('证据引用（每行一个路径）',{exact:true}).fill('/cases/0/evidence/output');
  await page.getByRole('button',{name:'保存人工意见',exact:true}).click();
  await expect(page.getByText('reviewer-a · 通过：Observed BUSINESS_OK',{exact:true})).toBeVisible();
  await page.getByLabel('标注者名称',{exact:true}).fill('reviewer-b');
  await page.getByLabel('人工结论',{exact:true}).selectOption('FAIL');
  await page.getByLabel('复核理由',{exact:true}).fill('Disputed example');
  await page.getByRole('button',{name:'保存人工意见',exact:true}).click();
  await expect(page.getByRole('button',{name:'提交争议复核结论',exact:true})).toBeVisible();
  await page.getByLabel('标注者名称',{exact:true}).fill('reviewer-c');
  await page.getByLabel('人工结论',{exact:true}).selectOption('PASS');
  await page.getByLabel('复核理由',{exact:true}).fill('Reviewed both opinions');
  await page.getByRole('button',{name:'提交争议复核结论',exact:true}).click();
  await expect(page.getByText('争议复核：通过 · Reviewed both opinions',{exact:true})).toBeVisible();
  const review=(await app.inject({url:'/api/evaluation-reviews?'+new URLSearchParams({kind:'migration',id:task.id,runId:run.id}),headers:{authorization:'Bearer '+token}})).json();
  assert.equal(review.records.length,3);assert.equal(review.summary[0].agreement,1);
  assert.equal(review.calibrations.length,2);
  assert.ok(review.calibrations.every(item=>item.compatible&&item.summary[0].agreement===1));
  await page.getByText('跨 Judge／重评版本校准',{exact:true}).click();
  await expect(page.getByText('原判定项缺失 0 项；新增未标注 0 项。',{exact:true}).first()).toBeVisible();
  const finalTask=(await app.inject({url:'/api/migration-tasks/'+task.id,headers:{authorization:'Bearer '+token}})).json();
  assert.deepEqual(finalTask.runs,analyzed.runs);assert.equal(judgments,4);assert.equal(host.creations.length,2);
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'PASSED',checks:['upload_and_prepare','shared_runtime_http_lifecycle','frozen_original_project',
    'evidence_then_judge','shared_report','no_candidate_promotion','instance_cleanup','rescore_without_runtime','preserved_baseline',
    'scoped_criteria','rule_editor','repeated_judging','independent_analysis','repeated_business_execution','human_annotations','dispute_adjudication','original_verdict_preserved','rescoring_calibration']}));
} finally {
  await browser?.close();await app.close();await host.app.close();await rm(data,{recursive:true,force:true});
}
