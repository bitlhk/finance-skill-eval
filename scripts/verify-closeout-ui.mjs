import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect} from '@playwright/test';
import {createEvaluationService} from '../dist/service/server.js';

const [historyDirectory,output]=process.argv.slice(2);
if(!historyDirectory||!output)throw Error('Pass the two-run evidence directory and screenshot directory');
await mkdir(output,{recursive:true});
const directory=await mkdtemp(path.join(os.tmpdir(),'closeout-ui-'));
await mkdir(path.join(directory,'runs'));
const ids=['run-20d0dc9c-5dc3-43de-b097-98b76e223488','run-5da1ef65-8ceb-4275-8cd9-5223e72a186b'];
const original=[];
for(const id of ids){const bytes=await readFile(path.join(historyDirectory,id+'.json'));original.push(bytes);await writeFile(path.join(directory,'runs',id+'.json'),bytes);}
const cancelled=JSON.parse(original[0]),completed=JSON.parse(original[1]);
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:directory,publicDirectory:path.resolve('web-dist'),accessToken:'isolated-closeout-test',publicDemo:false});
let browser;
try{
 const origin=await app.listen({host:'127.0.0.1',port:0});
 browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1366,height:900}});
 await page.addInitScript(()=>localStorage.setItem('finance-eval-token','isolated-closeout-test'));
 const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(origin);await page.getByRole('button',{name:'运行记录',exact:true}).click();
 await page.locator('.history-item').filter({hasText:'已取消'}).click();
 await expect(page.getByText('未取得最终执行结果；以下为最后快照')).toBeVisible();
 await expect(page.getByText('旧记录标记已取消；执行停止状态未记录。')).toBeVisible();
 await expect(page.locator('.live-state').filter({hasText:/^执行中$/})).toHaveCount(0);
 await page.screenshot({path:path.join(output,'cancel-desktop.png'),fullPage:true});
 await page.reload();await page.getByRole('button',{name:'运行记录',exact:true}).click();
 await page.locator('.history-item').filter({hasText:'已取消'}).click();
 await expect(page.getByText('未取得最终执行结果；以下为最后快照')).toBeVisible();
 const retried={...cancelled,jobId:'run-ui-isolated-retry',status:'cancelled',pack:completed.pack,live:{},evidence:[],
   executionSnapshot:{variants:completed.report.variants,models:completed.report.models,cases:completed.report.cases.map(({caseId,name,prompt})=>({caseId,name,prompt})),packFingerprint:completed.report.pack.fingerprint}};
 await page.route('**/api/runs/*/retry',route=>route.fulfill({json:retried}));
 await page.route('**/api/runs/run-ui-isolated-retry',route=>route.fulfill({json:retried}));
 await page.route('**/api/runs/run-ui-isolated-retry/events*',route=>route.fulfill({contentType:'text/event-stream',body:`data: ${JSON.stringify(retried)}\n\n`}));
 await page.getByRole('button',{name:'重试这一轮',exact:true}).click();
 await expect(page.getByRole('heading',{name:'meeting-action-demo · 冻结配置重试'})).toBeVisible();
 await expect(page.getByRole('heading',{name:/财富经理助手/})).toHaveCount(0);
 for(const row of completed.report.cases)await expect(page.getByText(row.prompt,{exact:true})).toBeVisible();
 for(const width of [1366,390,320]){
   await page.setViewportSize({width,height:900});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
   await page.screenshot({path:path.join(output,`retry-${width}.png`),fullPage:true});
 }
 assert.deepEqual(errors,[]);
 for(let i=0;i<ids.length;i++)assert((await readFile(path.join(historyDirectory,ids[i]+'.json'))).equals(original[i]));
 await writeFile(path.join(output,'browser.json'),JSON.stringify({status:'PASS',scope:'ISOLATED_UI_WITH_REAL_READONLY_HISTORY_AND_STUBBED_RETRY_NO_MODEL_CALL',checks:['cancel stale state and missing receipt','refresh','frozen retry Skill/versions/cases/runtime/model configuration','1366/390/320 no overflow','original history bytes unchanged'],errors},null,2));
 console.log('PASS: cancellation and frozen retry UI');
}finally{await browser?.close();await app.close();await rm(directory,{recursive:true,force:true});}
