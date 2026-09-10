import { chromium, expect } from '@playwright/test';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
const token=await readFile('.public-demo/ingress.token','utf8');
const base='http://127.0.0.1:56371';
const catalog=await fetch(`${base}/api/catalog`,{headers:{authorization:`Bearer ${token}`}}).then(r=>r.json());
const defaultModel=catalog.modelRoles.execution.model;
if(process.env.FINANCE_EVAL_EXPECTED_DEFAULT && defaultModel.modelId!==process.env.FINANCE_EVAL_EXPECTED_DEFAULT)throw new Error('Unexpected default execution model');
const out='/tmp/finance-eval-ui'; await mkdir(out,{recursive:true});
const browser=await chromium.launch();
const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[],checks=[];
page.on('pageerror',e=>errors.push(e.message));
// Exercise the demo application with the same trusted headers as its ingress.
// Platform login/SSO is verified separately at the real public endpoint.
await page.route(`${base}/api/**`,async route=>{
  const request=route.request(),headers={...request.headers(),authorization:`Bearer ${token}`,'x-demo-user':'studio_demo_smoke',origin:'https://finance-eval.demo.linggan.top'};
  if(request.method()==='POST') {
    const response=await fetch(request.url(),{method:'POST',body:request.postData()??undefined,headers});
    return route.fulfill({status:response.status,contentType:'application/json',body:await response.text()});
  }
  return route.continue({headers});
});
try {
  await page.goto(base); await page.getByRole('heading',{name:'灵感金融精选'}).waitFor();
  if(await page.getByRole('button',{name:'进入评测',exact:true}).count()!==7)throw new Error('Seven curated skill entries required');
  for(let i=0;i<7;i++) {
    await page.getByRole('button',{name:'进入评测',exact:true}).nth(i).click();
    await page.waitForTimeout(250);
    await page.getByText('在线环境已就绪',{exact:true}).waitFor();
    for(const panel of await page.locator('.comparison-panel').all())await expect(panel.locator('select').last()).toHaveValue(`${defaultModel.providerId}:${defaultModel.modelId}`);
    await page.getByRole('button',{name:'AI 动态出题',exact:true}).click();
    await expect(page.getByRole('button',{name:'AI 动态出题',exact:true})).toHaveAttribute('aria-pressed','true');
    await expect(page.locator('.case-row')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'开始测试',exact:true})).toBeEnabled();
    await page.getByRole('button',{name:'固定回归题',exact:true}).click();
    await expect(page.locator('.case-row input:checked')).toHaveCount(await page.locator('.case-row').count());
    checks.push({skill:i,cases:await page.locator('.case-row').count(),environment:await page.locator('.environment-readiness').innerText()});
    await expect(page.getByRole('button',{name:'开始测试',exact:true})).toBeEnabled();
    if(i===0) await page.screenshot({path:`${out}/comparison-desktop.png`,fullPage:true});
    await page.getByRole('button',{name:'AI 动态出题',exact:true}).click();
    await page.getByRole('button',{name:'精选技能',exact:true}).click();
  }
  await page.screenshot({path:`${out}/catalog-desktop.png`,fullPage:true});
  await page.getByRole('button',{name:'评测方法',exact:true}).click(); await page.waitForTimeout(300);
  await page.screenshot({path:`${out}/method-desktop.png`,fullPage:true});
  await page.setViewportSize({width:390,height:844}); await page.waitForTimeout(300);
  await page.screenshot({path:`${out}/method-mobile.png`,fullPage:true});
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Mobile page overflow');
  await page.getByRole('button',{name:'精选技能',exact:true}).click();
  await page.screenshot({path:`${out}/catalog-mobile.png`,fullPage:true});
  await page.getByRole('button',{name:'测试环境',exact:true}).click();
  for(const button of await page.getByRole('button',{name:'环境预检',exact:true}).all())await button.click();
  await page.getByText('已连通 · 1 个 MCP 服务 · 16 个工具',{exact:true}).waitFor();
  await page.screenshot({path:`${out}/environment-mobile.png`,fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  if(process.argv.includes('--ui-only')) {
    await page.getByRole('button',{name:'运行记录',exact:true}).click();
    await page.locator('.history-item').filter({has:page.locator('.run-status.completed')}).first().click();
    await page.locator('.quality-chart svg').first().waitFor();
    await page.screenshot({path:`${out}/report-desktop.png`,fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.waitForTimeout(400);
    if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))throw new Error('Report mobile overflow');
    await page.screenshot({path:`${out}/report-mobile.png`,fullPage:true});
    console.log(JSON.stringify({checks,errors,mode:'UI only, existing real reports'}));
    await page.unrouteAll({behavior:'wait'});await browser.close();process.exit(0);
  }
  await page.getByRole('button',{name:'精选技能',exact:true}).click();
  await page.getByRole('button',{name:'进入评测',exact:true}).first().click();
  await page.getByText('在线环境已就绪',{exact:true}).waitFor();
  await page.getByRole('button',{name:'固定回归题',exact:true}).click();
  await page.locator('.case-row input').nth(1).uncheck();
  const response=page.waitForResponse(r=>r.url()===`${base}/api/runs`&&r.request().method()==='POST');
  await page.getByRole('button',{name:'开始测试',exact:true}).click();
  const res=await response, job=await res.json();
  if(res.status()!==202)throw new Error(JSON.stringify(job));
  console.log(JSON.stringify({checks,jobId:job.jobId,errors}));
  let current;
  for(let i=0;i<180;i++) {
    await page.waitForTimeout(5000);
    current=await fetch(`${base}/api/runs/${job.jobId}`,{headers:{authorization:`Bearer ${token}`}}).then(r=>r.json());
    if(i%6===0)console.log(`${job.jobId}: ${current.status} ${current.progress.completedRuns}/${current.progress.totalRuns}`);
    if(['completed','failed','cancelled','interrupted'].includes(current.status))break;
  }
  await page.screenshot({path:`${out}/online-report.png`,fullPage:true});
  await writeFile(`${out}/verification.json`,JSON.stringify({checks,errors,jobId:job.jobId,status:current.status,summary:current.report?.summary},null,2));
  if(current.status!=='completed'||!current.report?.cases.every(c=>c.left.status==='completed'&&c.right.status==='completed'&&c.judge)||errors.length)throw new Error('Online UI verification failed');
  console.log(JSON.stringify({status:current.status,summary:current.report.summary,errors}));
}finally{await page.unrouteAll({behavior:'wait'});await browser.close();}
