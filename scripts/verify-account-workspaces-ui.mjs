import {chromium,expect} from '@playwright/test';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {createEvaluationService} from '../dist/service/server.js';

const root=await mkdtemp(path.join(tmpdir(),'eval-account-ui-'));
const out=path.resolve(process.env.ACCOUNT_UI_OUTPUT??'reports/account-workspaces-ui');
await mkdir(out,{recursive:true});await mkdir(path.join(root,'seed'));
const origin='https://eval.example.test';
const budgetTest=process.env.ACCOUNT_UI_BUDGET_TEST==='true';
const app=await createEvaluationService({rootDirectory:process.cwd(),publicDirectory:path.resolve('web-dist'),
  dataDirectory:path.join(root,'data'),accessToken:'synthetic-ingress',publicDemo:false,
  workspaceMode:'account',workspaceOrigin:origin,workspaceSubject:undefined,
  ...(budgetTest?{workspaceRequestLimits:{perAccount:1,global:2,windowSeconds:60}}:{}),
  workspaceSeedDirectory:path.join(root,'seed'),workspaceSeedSha256:createHash('sha256').update('[]').digest('hex')});
const base=await app.listen({host:'127.0.0.1',port:0});
const browser=await chromium.launch();
const errors=[];
async function account(subject){
  const context=await browser.newContext({viewport:{width:1366,height:900}});
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
  // Synthetic trusted ingress, not a simulated successful real Linggan login.
  await page.route(`${base}/api/**`,async route=>{
    const request=route.request();
    const headers={...request.headers(),authorization:'Bearer synthetic-ingress','x-demo-user':subject,origin};
    if(request.method()==='GET')await route.continue({headers});
    else await route.fulfill({response:await route.fetch({headers,maxRedirects:0})});
  });
  await page.goto(base);await page.getByRole('button',{name:'Skill 资产',exact:true}).click();
  return page;
}
try{
  const alice=await account('studio_alice');
  const zip=Buffer.from(zipSync({'SKILL.md':strToU8('---\nname: account-isolation-example\nversion: 1.0.0\ndescription: Synthetic account-private sample\n---\nUse only supplied synthetic facts.\n')}));
  const upload=alice.waitForResponse(response=>response.url().endsWith('/api/skills/upload')&&response.request().method()==='POST');
  await alice.locator('input[type=file]').setInputFiles({name:'account-example.zip',mimeType:'application/zip',buffer:zip});
  expect((await upload).status()).toBe(200);
  await expect(alice.locator('.asset-row').filter({hasText:'account-isolation-example'})).toBeVisible();
  await alice.screenshot({path:path.join(out,'alice-private-assets-desktop.png'),fullPage:true});
  const bob=await account('studio_bob');
  await expect(bob.getByText('尚未上传 Skill ZIP',{exact:true})).toBeVisible();
  await expect(bob.locator('.asset-row').filter({hasText:'account-isolation-example'})).toHaveCount(0);
  await bob.getByRole('button',{name:'测试环境',exact:true}).click();
  await expect(bob.getByText('平台已配置的执行环境；新增连接由维护者审核接入。',{exact:true})).toBeVisible();
  await expect(bob.locator('.header-actions button')).toHaveCount(0);
  await bob.screenshot({path:path.join(out,'managed-environments-desktop.png'),fullPage:true});
  for(const width of [390,320]){
    await alice.setViewportSize({width,height:844});
    expect(await alice.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await alice.screenshot({path:path.join(out,`alice-assets-${width}.png`),fullPage:true});
  }
  await alice.reload();
  await alice.getByRole('button',{name:'Skill 资产',exact:true}).click();
  await expect(alice.locator('.asset-row').filter({hasText:'account-isolation-example'})).toBeVisible();
  if(budgetTest){
    const refused=alice.waitForResponse(response=>response.url().endsWith('/api/skills/upload')&&response.request().method()==='POST');
    await alice.locator('input[type=file]').setInputFiles({name:'second-account-example.zip',mimeType:'application/zip',buffer:zip});
    const response=await refused;expect(response.status()).toBe(429);
    expect(Number(response.headers()['retry-after'])).toBeGreaterThan(0);
    await expect(alice.getByText(/当前账号请求较多，请在/)).toBeVisible();
    await alice.screenshot({path:path.join(out,'request-budget-message.png'),fullPage:true});
    await expect(alice.locator('.asset-row').filter({hasText:'account-isolation-example'})).toHaveCount(1);
  }
  expect(errors).toEqual([]);
  await writeFile(path.join(out,'report.json'),JSON.stringify({status:'PASSED',scope:'controlled account ingress, real service and browser',
    accounts:2,viewports:[1366,390,320],upload:true,accountIsolation:true,managedEnvironmentControls:true,reload:true,
    requestBudget:budgetTest?'VISIBLE_429_EXISTING_ASSET_PRESERVED':'NOT_TESTED',
    actualLingganLogin:'NOT_RUN',nativeRuntime:'NOT_RUN',modelCalls:0,bankCalls:0,errors},null,2));
  console.log(JSON.stringify({status:'PASSED',out}));
}finally{await browser.close();await app.close();await rm(root,{recursive:true,force:true});}
