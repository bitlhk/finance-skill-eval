import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {EvaluationRunManager} from '../dist/service/run-manager.js';
import {EvaluationJobStore} from '../dist/service/job-store.js';
import {loadEvalPack} from '../dist/eval-pack.js';
import {DeterministicRubricJudge} from '../dist/judge.js';
import {createEvaluationService} from '../dist/service/server.js';

// Real manager, runner, persistence and browser; controlled business Runtime, no model calls.
const data=await mkdtemp(path.join(os.tmpdir(),'comparison-repetitions-ui-'));
const jobs=new EvaluationJobStore(data);await jobs.initialize();
const manager=new EvaluationRunManager({jobs,maxConcurrentRuns:1});
const pack=await loadEvalPack('packs/finance/investment-research/eval.yaml');pack.cases=pack.cases.slice(0,1);
let creations=0,cleanups=0,browser,app;
const ids=new Set();
manager.resolvePack=async()=>structuredClone(pack);
manager.judgeFor=async()=>new DeterministicRubricJudge();
manager.runtimeFor=async()=>{
  creations++;
  return {adapterId:'controlled-business-runtime',cleanup:async()=>{cleanups++;},execute:async request=>{
    ids.add(request.runId);
    return {runId:request.runId,caseId:request.evalCase.caseId,side:request.side,status:'completed',
      modelId:request.model.modelId,skillVersion:'1',output:'Controlled business answer',elapsedMs:1,
      toolCalls:[],loadedSkills:[],usage:null,error:null,runtimeIdentityVerified:true,streamCompleted:true,metadata:{}};
  }};
};
try{
  const created=await manager.create({packId:pack.packId,runtime:{type:'direct_model'},executionRepetitions:2,repeatSafety:'read_only'});
  await expect.poll(()=>jobs.get(created.jobId)?.status,{timeout:60000}).toBe('completed');
  assert.equal(creations,2);assert.equal(cleanups,2);assert.equal(ids.size,2);
  assert.equal(jobs.get(created.jobId).executionAttempts.length,2);
  await manager.close();
  const token='comparison-repetitions-test';
  app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:data,publicDirectory:path.join(process.cwd(),'web-dist'),accessToken:token,publicDemo:false});
  app.log.level='error';const url=await app.listen({host:'127.0.0.1',port:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url);await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'运行记录',exact:true}).click();
  await expect(page.getByText('业务重复运行 · 计划 2 次',{exact:true})).toBeVisible();
  await page.getByText('第 1 次 · 已形成报告',{exact:true}).click();
  await expect(page.getByText('Controlled business answer',{exact:true}).first()).toBeVisible();
  await expect(page.getByText('第 2 次 · 已形成报告',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'对比评测',exact:true}).click();
  await expect(page.getByLabel('对比业务运行次数',{exact:true})).toBeVisible();
  assert.deepEqual(errors,[]);
  console.log(JSON.stringify({status:'PASSED',creations,cleanups,distinctRuns:ids.size,checks:['shared_runner','saved_attempts','history_cards','comparison_entry']}));
}finally{
  await manager.close();await browser?.close();await app?.close();await rm(data,{recursive:true,force:true});
}
