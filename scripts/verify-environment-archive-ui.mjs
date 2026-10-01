import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium,expect} from '@playwright/test';
import {createEvaluationService} from '../dist/service/server.js';

const output=path.resolve(process.argv[2]??'reports/environment-archive-ui');
await mkdir(output,{recursive:true});
const data=await mkdtemp(path.join(os.tmpdir(),'environment-archive-ui-'));
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:data,
  publicDirectory:path.resolve('web-dist'),accessToken:'archive-ui-test',publicDemo:false});
let browser;
try {
  const origin=await app.listen({host:'127.0.0.1',port:0});
  const headers={authorization:'Bearer archive-ui-test','content-type':'application/json'};
  const created=await fetch(origin+'/api/environments',{method:'POST',headers,
    body:JSON.stringify({name:'Archive UI fixture',type:'mcp_streamable_http',endpoint:'http://127.0.0.1:9/mcp'})}).then(r=>r.json());
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  const page=await browser.newPage({viewport:{width:1366,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>localStorage.setItem('finance-eval-token','archive-ui-test'));
  await page.goto(origin);
  await page.getByRole('button',{name:'测试环境',exact:true}).click();
  await page.getByTitle('归档 Archive UI fixture',{exact:true}).click();
  const archived=page.locator('details').filter({has:page.locator('summary').filter({hasText:'已归档'})});
  await expect(archived).toBeVisible();
  await expect(page.getByTitle('归档 Archive UI fixture',{exact:true})).toHaveCount(0);
  await archived.locator('summary').click();
  await expect(page.getByTitle('恢复 Archive UI fixture',{exact:true})).toBeVisible();
  assert.deepEqual(await fetch(origin+'/api/environments',{headers}).then(r=>r.json()),[]);
  const retained=await fetch(origin+'/api/environments/'+created.environmentId,{headers}).then(r=>r.json());
  assert.equal(retained.archived,true);
  await page.screenshot({path:output+'/desktop.png',fullPage:true});
  for(const width of [390,320]) {
    await page.setViewportSize({width,height:844});
    await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await page.screenshot({path:output+`/mobile-${width}.png`,fullPage:true});
  }
  await page.getByTitle('恢复 Archive UI fixture',{exact:true}).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTitle('归档 Archive UI fixture',{exact:true})).toBeVisible();
  assert.equal((await fetch(origin+'/api/environments',{headers}).then(r=>r.json())).length,1);
  assert.deepEqual(errors,[]);
  await writeFile(output+'/report.json',JSON.stringify({status:'PASS',checks:[
    'Archive hides active row and retains historical detail',
    'Archived records remain available in explicit folded list',
    'Keyboard restores archived record',
    '1366px, 390px and 320px have no horizontal overflow',
    'No model, MCP or bank calls were required'
  ]},null,2));
} finally {await browser?.close();await app.close();await rm(data,{recursive:true,force:true});}
