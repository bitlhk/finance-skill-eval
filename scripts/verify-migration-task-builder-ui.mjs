import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
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
const verifyOptimization=process.env.FINANCE_VERIFY_WAIT_BUILDER==='1';
let upgraded=false;
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:data,publicDirectory:path.resolve(process.env.MIGRATION_TEST_WEB_DIR||'web-dist'),accessToken:token,publicDemo:false,
  launcherTrust:[{reference:'fixture',label:'测试 Builder',baseUrlPrefix:host.baseUrl,credentialEnv:null}],
  bundlePorts:{agent:async input=>input.mode==='ANALYZE'?{status:'PRODUCED',analysis:{summary:'检查整组依赖',changes:[],missing:[]}}:{status:'PRODUCED',files:{...input.base.files,...(verifyOptimization&&input.mode==='REPAIR'?{'agent/runtime.py':Buffer.from('MAX_STEPS = 4').toString('base64')}:{})},delivery:{summary:'整体迁移完成',services:[]}},judge:async()=>({passed:!verifyOptimization||upgraded,reason:'Protocol fixture'}),
    improvementAgents:()=>({diagnose:async()=>({judgement:{status:'PROPOSED',hypothesis:{layer:'HARNESS',issue:'执行轮次不足',expectedBehavior:'完成业务工作流',evidenceCaseIds:['dev'],validation:'复测业务流程',risk:'保持工具独立',confidence:'HIGH',projectPaths:['agent/runtime.py']}}}),
      review:async()=>({status:'PRODUCED',review:{recommendation:'KEEP_CANDIDATE',reason:'已验证新 Runtime 的整体效果',improvements:['工作流完成'],regressions:[],evidenceIds:['dev']}})})}});
app.log.level='error';let browser,page,proxy;
try{
  let serviceUrl=await app.listen({host:'127.0.0.1',port:0});
  const prefix=process.env.MIGRATION_TEST_PREFIX;
  let gatewayAuthenticated=0;
  if(prefix){
    assert(/^\/[a-z-]+\/$/u.test(prefix));
    const target=serviceUrl;
    proxy=http.createServer((request,response)=>{
      if(!request.url.startsWith(prefix)){response.writeHead(404);response.end();return;}
      const headers={...request.headers};
      if(process.env.MIGRATION_TEST_PRIVATE_GATEWAY==='true'){
        headers.authorization=String(headers['x-migration-authorization']||'');
        delete headers['x-migration-authorization'];
        if(headers.authorization==='Bearer '+token)gatewayAuthenticated++;
      }
      const upstream=http.request(new URL(request.url.slice(prefix.length-1),target),{method:request.method,headers},result=>{
        response.writeHead(result.statusCode,result.headers);result.pipe(response);
      });
      upstream.on('error',()=>{response.writeHead(502);response.end();});request.pipe(upstream);
    });
    await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    serviceUrl=`http://127.0.0.1:${proxy.address().port}${prefix}`;
    assert.equal((await fetch(new URL('/api/migration-tasks',serviceUrl))).status,404);
  }
  assert.equal((await fetch(new URL('api/migration-tasks',serviceUrl))).status,401);
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  page=await browser.newPage({viewport:{width:1440,height:1100},acceptDownloads:true});page.on('pageerror',e=>errors.push(e.message));
  const openDetails = async name => {
    const summary = page.getByText(name,{exact:true});
    if (!await summary.evaluate(node => node.parentElement.open)) await summary.click();
  };
  await page.goto(serviceUrl);await page.getByLabel('访问令牌').fill(token);await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
  await page.getByRole('button',{name:'新建迁移',exact:true}).click();
  const stage=name=>page.getByRole('navigation',{name:'迁移步骤'}).getByRole('button',{name:new RegExp(name)}).click();
  for(const count of [1,3]){ console.log(`Starting ${count} members`);
    upgraded=false;
    if(count===3){ await page.getByRole('button',{name:'返回迁移列表',exact:true}).click(); await page.getByRole('button',{name:'新建迁移',exact:true}).click(); }
    await page.getByText('补充要求（可选）',{exact:true}).click();
    await page.getByLabel('任务名称（可选）',{exact:true}).fill('Builder '+count+' Skill');
    await page.getByLabel('额外业务要求（可选）',{exact:true}).fill('协作完成业务任务');
    const archive=zipSync({...Object.fromEntries(Array.from({length:count},(_,i)=>[`skills/s${i}/SKILL.md`,Buffer.from(`---\nname: s${i}\ndescription: business\n---\nBusiness task.`)])),...(verifyOptimization?{'agent/runtime.py':Buffer.from('MAX_STEPS = 2')}:{})});
    await page.locator('.bundle-panel input[type=file]').first().setInputFiles({name:'skills.zip',mimeType:'application/zip',buffer:Buffer.from(archive)});
    await page.getByRole('button',{name:'开始诊断',exact:true}).click();await expect(page.getByRole('heading',{name:'改造内容总览',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'确认方案并继续',exact:true}).click();await page.locator('.migration-stage').getByRole('button',{name:'生成迁移结果',exact:true}).click();
    await expect(page.getByText('查看完整迁移说明',{exact:true})).toBeVisible();await openDetails('查看完整迁移说明');await expect(page.getByText('整体迁移完成',{exact:true}).first()).toBeVisible();
    await stage('准备运行环境'); await openDetails('接入其他运行环境');
    const download=page.waitForEvent('download'); download.catch(()=>{}); await page.getByRole('button',{name:'生成并下载 Builder 需求',exact:true}).click(); await expect(page.getByRole('alert')).toHaveCount(0);
    const req=parse(await readFile(await (await download).path(),'utf8'));assert.equal(req.executionRequirements.limits.maxSkills,count);assert.equal(req.target.protocols.instance,'finance.runtime-instance.v1');assert(!req.source&&!req.extensions);
    const allTasks=(await app.inject({url:'/api/migration-tasks',headers:{authorization:'Bearer '+token}})).json();const taskId=allTasks.find(t=>t.name==='Builder '+count+' Skill').id;
    let result=taskBuilderResult(req,host,withResultDigest,canonicalSha256,String(count));
    await page.getByLabel('Builder Result',{exact:true}).fill(JSON.stringify({...result,requirementsDigest:'a'.repeat(64)}));
    await page.getByRole('button',{name:'验证并绑定 Builder 交付',exact:true}).click();await expect(page.getByRole('alert')).toContainText('交付未通过验收');
    await page.getByLabel('导入 Builder Result JSON',{exact:true}).setInputFiles({name:'result.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(result))});
    await page.getByRole('button',{name:'验证并绑定 Builder 交付',exact:true}).click();
    await openDetails('接入其他运行环境'); await expect(page.getByText('绑定状态：Runtime 交付有效',{exact:true})).toBeVisible({timeout:15000});
    assert(host.creations.at(-1).skills.length===1);assert.equal(host.instances.size,0);
    await page.screenshot({path:path.join(screenshots,`bound-${count}.png`),fullPage:true});
    await stage('验证实际效果');
  await openDetails('高级设置：导入与编辑测试集');await page.getByLabel('验收测试集 JSON').fill(JSON.stringify({name:'Business',cases:[{id:'dev',input:'业务任务',criteria:['BUSINESS_OK']}],holdoutCases:[{id:'held',input:'独立任务',criteria:['BUSINESS_OK']}]}));
    await page.getByRole('button',{name:'保存测试集',exact:true}).click();await page.getByRole('button',{name:'开始验证实际效果',exact:true}).click();
    if(verifyOptimization){
      await expect(page.getByRole('button',{name:'按目标优化并复测',exact:true})).toBeEnabled();
      await page.getByRole('button',{name:'按目标优化并复测',exact:true}).click();
      await expect(page.getByLabel('继续优化',{exact:true})).toContainText('Builder',{timeout:15000});
      await expect(page.getByRole('button',{name:'继续本轮优化',exact:true})).toBeDisabled();
      await expect(page.getByRole('button',{name:'保存测试集',exact:true})).toBeDisabled();
      await page.screenshot({path:path.join(screenshots,`optimization-waiting-${count}.png`),fullPage:true});
      await page.getByRole('button',{name:'前往准备运行环境',exact:true}).click();await openDetails('接入其他运行环境');
      const projectDownload=page.waitForEvent('download');await page.getByRole('button',{name:'下载待构建工程与诊断',exact:true}).click();
      const projectFiles=unzipSync(await readFile(await(await projectDownload).path()));assert.equal(Buffer.from(projectFiles['agent/runtime.py']).toString(),'MAX_STEPS = 4');
      const requestDownload=page.waitForEvent('download');await page.getByRole('button',{name:'生成并下载 Builder 需求',exact:true}).click();
      const rebuild=parse(await readFile(await(await requestDownload).path(),'utf8'));assert.equal(rebuild.rebuild.hypothesis.issue,'执行轮次不足');
      result=taskBuilderResult(rebuild,host,withResultDigest,canonicalSha256,'optimized-'+count);
      await page.getByLabel('Builder Result',{exact:true}).fill(JSON.stringify(result));await page.getByRole('button',{name:'验证并绑定 Builder 交付',exact:true}).click();
      await openDetails('接入其他运行环境');await expect(page.getByRole('button',{name:'继续本轮优化',exact:true})).toBeEnabled({timeout:15000});
      upgraded=true;await page.getByRole('button',{name:'继续本轮优化',exact:true}).click();
      await expect(page.getByLabel('优化过程',{exact:true})).toContainText('已验证新 Runtime 的整体效果',{timeout:15000});
      await page.getByRole('button',{name:'选择审查通过的候选',exact:true}).click();
      await page.screenshot({path:path.join(screenshots,`optimization-resumed-${count}.png`),fullPage:true});
      checks.push(`${count}-members: project-code-repair, persistent-builder-wait, project-export, matching-rebuild, same-round-resume, whole-solution-review`);
    }
    await expect(page.getByRole('heading',{name:'通过 · 1/1 个案例通过',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'执行独立留出验收',exact:true}).click();
    await expect.poll(async()=>{const tasks=(await app.inject({url:'/api/migration-tasks',headers:{authorization:'Bearer '+token}})).json();return tasks.find(t=>t.id===taskId)?.runs.at(-1)?.phase+':'+tasks.find(t=>t.id===taskId)?.runs.at(-1)?.status;}).toBe('holdout:PASSED');
    await stage('下载结果');const verified=page.waitForEvent('download');await page.getByRole('button',{name:'下载已验收交付包',exact:true}).click();
    const files=unzipSync(await readFile(await (await verified).path()));const manifest=JSON.parse(Buffer.from(files['migration/manifest.json']).toString());assert.equal(manifest.verified,true);assert.equal(manifest.builderBinding.result.resultDigest,result.resultDigest);
    await stage('准备运行环境'); await openDetails('接入其他运行环境');await openDetails('高级运行设置');await page.getByLabel('每个案例超时（秒）').fill('320');await page.getByRole('button',{name:'核对所选环境',exact:true}).click();
    await stage('准备运行环境'); await openDetails('接入其他运行环境');await openDetails('接入其他运行环境'); await expect(page.getByText('绑定状态：Runtime 交付有效',{exact:true})).toBeVisible();
    await page.setViewportSize({width:390,height:844});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Builder mobile overflow');await page.screenshot({path:path.join(screenshots,`stale-mobile-${count}.png`),fullPage:true});await page.setViewportSize({width:1440,height:1100});
    await stage('验证实际效果');
  await openDetails('高级设置：导入与编辑测试集');await expect(page.getByRole('button',{name:'开始验证实际效果',exact:true})).toBeEnabled();
    await stage('准备运行环境'); await openDetails('接入其他运行环境');await page.getByRole('button',{name:'切换为已有环境',exact:true}).click();await expect(page.getByText('绑定状态：使用已有环境',{exact:true})).toBeVisible();
    checks.push(`${count}-members: requirements, requirements-only, bad-result-rejected, standard-intake, development, holdout, verified-export, runtime-reuse-after-config-change, explicit-existing-runtime, mobile`);
  }
  if(prefix&&process.env.MIGRATION_TEST_PRIVATE_GATEWAY==='true')assert(gatewayAuthenticated>0,'Gateway did not receive the private authorization header');
  checks.push('unauthenticated-api-rejected',...(prefix?['private-subpath', 'outside-prefix-rejected']:[]));
  assert.deepEqual(errors,[]);console.log(JSON.stringify({status:'PASSED',scope:'DETERMINISTIC_UI_PROTOCOL_REGRESSION',checks},null,2));
}catch(error){if(page){await page.screenshot({path:path.join(screenshots,'failure.png'),fullPage:true});console.log(await page.locator('.bundle-panel').innerText());}throw error;}finally{await browser?.close();if(proxy){proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}await app.close();await host.app.close();await rm(data,{recursive:true,force:true});}
