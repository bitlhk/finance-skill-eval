import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {zipSync,strToU8} from 'fflate';
import {createEvaluationService} from '../dist/service/server.js';

// Real UI and service; A2 is recorded to verify import/navigation without model variability.
const root=process.cwd(),data=await mkdtemp(path.join(os.tmpdir(),'migration-import-ui-'));
const output=path.join(root,'reports','migration-import-ui');await mkdir(output,{recursive:true});
const checks=[],errors=[],token='local-import-verification';
const pass=name=>{checks.push(name);console.log('PASS '+name)};
const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,publicDirectory:path.join(root,'web-dist'),accessToken:token,publicDemo:false,
 migrationAnalyzer:async input=>({status:'PRODUCED',payload:{status:'PRODUCED',skill:{status:'COMPLIANT',findings:[]},tools:[],dependencyAnalysis:{dependencies:[],chains:[]},coverageGaps:[]},scanner:{scannerDigest:'a'.repeat(64),coverage:Object.keys(input.files).map(p=>({path:p,status:'TEXT_INSPECTED'}))}})});
app.addHook('onRequest',async req=>{if(req.url==='/api/migrations/upload')await new Promise(resolve=>setTimeout(resolve,250))});
let browser;
try{
 const url=await app.listen({host:'127.0.0.1',port:0});
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(url);await page.getByLabel('访问令牌').fill(token);await page.getByRole('button',{name:'进入工作区',exact:true}).click();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
 await page.getByRole('button',{name:'新建迁移',exact:true}).click();
 await expect(page.getByRole('heading',{name:'准备导入文件',exact:true})).toBeVisible();
 await expect(page.getByText('ZIP 可以保留现有目录结构和外层文件夹',{exact:false})).toBeVisible();
 await expect(page.getByRole('button',{name:'开始诊断',exact:true})).toBeDisabled();
 pass('导入说明允许原目录，未选资产时不可诊断');
 const fileInput=page.locator('input[type=file][multiple]');
 assert((await fileInput.getAttribute('accept')).includes('.md'));
 const source=name=>`---\nname: ${name}\ndescription: 导入页面验证\n---\n使用已提供的业务资料完成任务。`;
 const zip=(files,name)=>({name,mimeType:'application/zip',buffer:Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k,v])=>[k,strToU8(v)]))))});
 await fileInput.setInputFiles(zip({'original/project/SKILL.md':source('nested-import'),'original/sdk/tool.py':'def query(): pass','README.md':'notes'},'nested-source.zip'));
 await expect(page.getByRole('status').filter({hasText:'上传中'})).toBeVisible();
 await expect(page.getByRole('button',{name:'2 诊断与补充',exact:true})).toHaveClass(/active/,{timeout:30000});
 await expect(page.locator('ul[aria-label="导入结果"]')).toContainText('nested-source.zip：已导入');
 const headers={authorization:`Bearer ${token}`};
 let projects=await (await fetch(url+'/api/migrations',{headers})).json();assert.equal(projects.length,1);
 pass('嵌套 ZIP + 任意顶层文件导入成功，进入诊断且只创建一个项目');
 await page.getByRole('button',{name:'返回迁移列表',exact:true}).click();
 await fileInput.setInputFiles({name:'standalone.md',mimeType:'text/markdown',buffer:Buffer.from(source('markdown-import'))});
 await expect(page.getByRole('button',{name:'2 诊断与补充',exact:true})).toHaveClass(/active/,{timeout:30000});
 await expect(page.locator('h2').filter({hasText:'markdown-import'})).toBeVisible();
 projects=await (await fetch(url+'/api/migrations',{headers})).json();assert.equal(projects.length,2);
 pass('独立 Markdown 导入并进入诊断，无重复项目');
 await page.getByRole('button',{name:'返回迁移列表',exact:true}).click();
 await fileInput.setInputFiles([
  zip({'repo/instructions.md':source('batch-zip'),'repo/tool.py':'def lookup(): pass'},'batch-source.zip'),
  {name:'broken.zip',mimeType:'application/zip',buffer:Buffer.from('broken')},
  {name:'batch.md',mimeType:'text/markdown',buffer:Buffer.from(source('batch-markdown'))}
 ]);
 const results=page.locator('ul[aria-label="导入结果"]');
 await expect(results).toContainText('batch-source.zip：已导入',{timeout:30000});await expect(results).toContainText('batch.md：已导入');
 await expect(results).toContainText('broken.zip：ZIP 文件损坏');
 await expect(page.getByRole('button',{name:'继续处理',exact:true})).toHaveCount(4);
 projects=await (await fetch(url+'/api/migrations',{headers})).json();assert.equal(projects.length,4);
 pass('混合批量上传：两项成功分别创建项目，坏 ZIP 显示原因，停留列表');
 await fileInput.setInputFiles({name:'too-large.md',mimeType:'text/markdown',buffer:Buffer.alloc(8*1024*1024+1,65)});
 await expect(results).toContainText('单个文件不能超过 8 MB');
 projects=await (await fetch(url+'/api/migrations',{headers})).json();assert.equal(projects.length,4);
 pass('超大文件明确提示且不创建项目');
 await fileInput.setInputFiles(zip({'repo/instructions.md':source('recovery')},'recovery.zip'));
 await expect(page.getByRole('button',{name:'2 诊断与补充',exact:true})).toHaveClass(/active/,{timeout:30000});
 pass('失败后仍可重新上传并正常进入诊断');
 await expect(page.getByText('正在处理，请稍候…',{exact:true})).toHaveCount(0,{timeout:30000});
 await page.getByRole('button',{name:'返回迁移列表',exact:true}).click();
 await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'新建迁移',exact:true}).click();
 await expect(page.getByRole('button',{name:'上传 ZIP 或 Markdown',exact:true})).toBeEnabled();
 pass('任务结束后上传按钮恢复可用');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
 await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
 pass('窄屏导入页无横向溢出');assert.deepEqual(errors,[]);pass('无浏览器 JavaScript 错误');
 await writeFile(path.join(output,'result.json'),JSON.stringify({status:'PASSED',analyzer:'RECORDED_FIXTURE',checks},null,2));
 console.log(JSON.stringify({status:'PASSED',checks}));
}catch(error){await writeFile(path.join(output,'result.json'),JSON.stringify({status:'FAILED',checks,error:String(error)},null,2));throw error}
finally{await browser?.close();await app.close();await rm(data,{recursive:true,force:true})}
