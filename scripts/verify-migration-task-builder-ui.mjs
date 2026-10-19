import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium, expect } from '@playwright/test';
import { zipSync, unzipSync } from 'fflate';
import { parse } from 'yaml';
import { createEvaluationService } from '../dist/service/server.js';
import { canonicalSha256 } from '../dist/shared/json-canonicalization.js';
import { withResultDigest } from '../dist/shared/contracts/runtime-builder.js';
import { taskBuilderLauncher, taskBuilderResult } from './lib/task-builder-test-launcher.mjs';

// UI/API/protocol regression with deterministic Agent, Judge and Launcher fixture.
const host=await taskBuilderLauncher(), data=await mkdtemp(path.join(os.tmpdir(),'builder-ui-'));
const screenshots=path.resolve('artifacts/task-builder-ui');await mkdir(screenshots,{recursive:true});
const token='builder-ui-local',checks=[],errors=[];
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:data,publicDirectory:path.resolve('web-dist'),accessToken:token,publicDemo:false,
  launcherTrust:[{reference:'fixture',label:'测试 Builder',baseUrlPrefix:host.baseUrl,credentialEnv:null}],
  bundlePorts:{agent:async input=>input.mode==='ANALYZE'?{status:'PRODUCED',analysis:{summary:'检查整组依赖',changes:[],missing:[]}}:{status:'PRODUCED',files:input.base.files,delivery:{summary:'整体迁移完成',services:[]}},judge:async()=>({passed:true,reason:'Protocol fixture'})}});
app.log.level='error';let browser,page;
try{
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(await app.listen({host:'127.0.0.1',port:0}));await page.getByLabel('访问令牌').fill(token);await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
  const stage=name=>page.getByRole('navigation',{name:'迁移步骤'}).getByRole('button',{name:new RegExp(name)}).click();
  for(const count of [1,3]){ console.log(`Starting ${count} members`);
    if(count===3)await page.getByRole('button',{name:'任务列表 / 新建',exact:true}).click();
    await page.getByLabel('任务名称',{exact:true}).fill('Builder '+count+' Skill');
    await page.getByLabel('业务目标',{exact:true}).fill('协作完成业务任务');await page.getByLabel('目标环境与要求',{exact:true}).fill('OpenJiuwen');
    const archive=zipSync(Object.fromEntries(Array.from({length:count},(_,i)=>[`skills/s${i}/SKILL.md`,Buffer.from(`---\nname: s${i}\ndescription: business\n---\nBusiness task.`)])));
    await page.locator('.bundle-panel input[type=file]').first().setInputFiles({name:'skills.zip',mimeType:'application/zip',buffer:Buffer.from(archive)});
    await page.getByRole('button',{name:'分析 Skill 工程',exact:true}).click();await expect(page.getByText('检查整组依赖',{exact:true})).toBeVisible();
    await stage('生成迁移结果');await page.getByRole('button',{name:'生成迁移结果',exact:true}).click();await expect(page.getByText('整体迁移完成',{exact:true})).toBeVisible();
    await stage('Runtime 适配与登记');
    const download=page.waitForEvent('download'); download.catch(()=>{}); await page.getByRole('button',{name:'生成并下载 Builder 需求',exact:true}).click(); await expect(page.getByRole('alert')).toHaveCount(0);
    const req=parse(await readFile(await (await download).path(),'utf8'));assert.equal(req.extensions.migrationTask.members.length,count);assert.equal(req.extensions.migrationTask.instanceSchemaVersion,'finance.skill-eval.runtime-instance.v2');
    const sourceDownload=page.waitForEvent('download');await page.getByRole('button',{name:'下载绑定的候选源码',exact:true}).click();assert.equal(Object.keys(unzipSync(await readFile(await (await sourceDownload).path()))).length,count);
    const result=taskBuilderResult(req,host,withResultDigest,canonicalSha256,String(count));
    await page.getByLabel('Builder Result',{exact:true}).fill(JSON.stringify({...result,requirementsDigest:'a'.repeat(64)}));
    await page.getByRole('button',{name:'验证并绑定 Builder 交付',exact:true}).click();await expect(page.getByRole('alert')).toContainText('交付未通过验收');
    await page.getByLabel('导入 Builder Result JSON',{exact:true}).setInputFiles({name:'result.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(result))});
    await page.getByRole('button',{name:'验证并绑定 Builder 交付',exact:true}).click();
    await expect(page.getByText('绑定状态：已绑定当前候选与配置',{exact:true})).toBeVisible({timeout:15000});
    assert(host.creations.at(-1).bundle.members.length===count);assert.equal(host.instances.size,0);
    await page.screenshot({path:path.join(screenshots,`bound-${count}.png`),fullPage:true});
    await stage('任务验收');await page.getByLabel('验收测试集 JSON').fill(JSON.stringify({name:'Business',cases:[{id:'dev',input:'业务任务',criteria:['BUSINESS_OK']}],holdoutCases:[{id:'held',input:'独立任务',criteria:['BUSINESS_OK']}]}));
    await page.getByRole('button',{name:'保存测试集',exact:true}).click();await page.getByRole('button',{name:'开始任务验收',exact:true}).click();
    await expect(page.getByRole('heading',{name:'通过 · 1/1 个案例通过',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'执行独立留出验收',exact:true}).click();
    await expect.poll(async()=>{const tasks=(await app.inject({url:'/api/migration-tasks',headers:{authorization:'Bearer '+token}})).json();return tasks.find(t=>t.id===req.extensions.migrationTask.taskId)?.runs.at(-1)?.phase+':'+tasks.find(t=>t.id===req.extensions.migrationTask.taskId)?.runs.at(-1)?.status;}).toBe('holdout:PASSED');
    await stage('下载结果');const verified=page.waitForEvent('download');await page.getByRole('button',{name:'下载已验收交付包',exact:true}).click();
    const files=unzipSync(await readFile(await (await verified).path()));const manifest=JSON.parse(Buffer.from(files['migration/manifest.json']).toString());assert.equal(manifest.verified,true);assert.equal(manifest.builderBinding.result.resultDigest,result.resultDigest);
    await stage('Runtime 适配与登记');await page.getByLabel('每个案例超时（秒）').fill('320');await page.getByRole('button',{name:'保存运行配置',exact:true}).click();
    await stage('Runtime 适配与登记');await expect(page.getByText('绑定状态：绑定已失效，请重新导出需求',{exact:true})).toBeVisible();
    await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Builder mobile overflow');await page.screenshot({path:path.join(screenshots,`stale-mobile-${count}.png`),fullPage:true});await page.setViewportSize({width:1440,height:1100});
    await stage('任务验收');await expect(page.getByRole('button',{name:'开始任务验收',exact:true})).toBeDisabled();
    await stage('Runtime 适配与登记');await page.getByRole('button',{name:'切换为已有环境',exact:true}).click();await expect(page.getByText('绑定状态：使用已有环境',{exact:true})).toBeVisible();
    checks.push(`${count}-members: requirements, pinned-source, bad-result-rejected, v2-intake, development, holdout, verified-export, stale-binding, explicit-existing-runtime, mobile`);
  }
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASSED',scope:'DETERMINISTIC_UI_PROTOCOL_REGRESSION',checks},null,2));
}catch(error){if(page){await page.screenshot({path:path.join(screenshots,'failure.png'),fullPage:true});console.log(await page.locator('.bundle-panel').innerText());}throw error;}finally{await browser?.close();await app.close();await host.app.close();await rm(data,{recursive:true,force:true});}
