import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {zipSync,strToU8} from 'fflate';
import {createEvaluationService} from '../dist/service/server.js';

// Real browser, API and archive storage; this test does not call Agent/Runtime/Judge.
const root=process.cwd(),data=await mkdtemp(path.join(os.tmpdir(),'migration-import-ui-'));
const output=path.join(root,'reports','migration-import-ui');await mkdir(output,{recursive:true});
const checks=[],errors=[],token='local-import-verification';
const pass=name=>checks.push(name);
const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,publicDirectory:path.join(root,'web-dist'),accessToken:token,publicDemo:false});
app.log.level='error';
const source=name=>'---\nname: '+name+'\ndescription: Real source import\n---\nRead business data.';
const zip=(files,name)=>({name,mimeType:'application/zip',buffer:Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([key,value])=>[key,strToU8(value)]))))});
let browser;
try {
  const url=await app.listen({host:'127.0.0.1',port:0});
  const tasks=async()=>{const response=await fetch(url+'/api/migration-tasks',{headers:{authorization:'Bearer '+token}});assert(response.ok);return response.json();};
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.getByLabel('访问令牌').fill(token);await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
  await expect(page.getByRole('button',{name:'单个 Skill 迁移',exact:true})).toHaveCount(0);
  await page.getByLabel('任务名称',{exact:true}).fill('单 Skill 导入');
  await page.getByLabel('业务目标',{exact:true}).fill('验证业务数据');
  await page.getByLabel('目标环境与要求',{exact:true}).fill('OpenJiuwen');
  const input=()=>page.locator('.bundle-panel input[type=file]');
  await input().nth(1).setInputFiles([
    zip({'repo/SKILL.md':source('nested-import'),'repo/tool.py':'print(1)'},'nested.zip'),
    {name:'broken.zip',mimeType:'application/zip',buffer:Buffer.from('broken')},
    {name:'standalone.md',mimeType:'text/markdown',buffer:Buffer.from(source('markdown-import'))},
  ]);
  await expect(page.getByRole('status')).toContainText('已导入 2 个 Skill');
  await expect(page.getByRole('status')).toContainText('broken.zip');
  assert.equal((await tasks()).length,0);
  pass('mixed_upload_reports_individual_failures_without_creating_separate_tasks');
  const selections=page.locator('.bundle-member-options input[type=checkbox]');
  await expect(selections).toHaveCount(2);await selections.first().uncheck();
  await page.getByText(/依赖文件（可选/).click();
  await page.getByLabel('添加依赖文件',{exact:true}).setInputFiles({name:'rules.json',mimeType:'application/json',buffer:Buffer.from('{"limit":100}')});
  await expect(page.getByLabel('依赖文件路径',{exact:true})).toHaveValue('shared/rules.json');
  await page.getByLabel('依赖文件路径',{exact:true}).fill('shared/business-rules.json');
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Optional dependency UI overflows mobile');
  await page.screenshot({path:path.join(output,'optional-assets-mobile.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('button',{name:'创建迁移任务',exact:true}).click();
  await expect(page.getByRole('heading',{name:'单 Skill 导入',exact:true})).toBeVisible();
  assert.equal((await tasks())[0].source.members.length,1);
  const dependency=await fetch(url+'/api/migration-tasks/'+(await tasks())[0].id+'/file?path=shared/business-rules.json',{headers:{authorization:'Bearer '+token}});
  assert.equal((await dependency.json()).content,'{"limit":100}');
  pass('independent_skill_optional_dependency_and_editable_path_without_project_archive');
  pass('one_selected_asset_creates_one_unified_task');
  await page.getByRole('button',{name:'任务列表 / 新建',exact:true}).click();
  await page.getByLabel('任务名称',{exact:true}).fill('工程整体导入');
  await input().first().setInputFiles(zip({'repo/a/SKILL.md':source('a'),'repo/b/SKILL.md':source('b'),'repo/shared/tool.py':'print(2)'},'whole.zip'));
  await expect(page.getByRole('heading',{name:'工程整体导入',exact:true})).toBeVisible();
  const records=await tasks();assert.equal(records.length,2);
  const whole=records.find(t=>t.name==='工程整体导入');assert.equal(whole.source.members.length,2);
  const file=await fetch(url+'/api/migration-tasks/'+whole.id+'/file?path=repo/shared/tool.py',{headers:{authorization:'Bearer '+token}});
  assert.equal((await file.json()).content,'print(2)');
  pass('whole_project_keeps_members_shared_code_and_relative_paths');
  await page.getByRole('button',{name:'任务列表 / 新建',exact:true}).click();
  await input().nth(1).setInputFiles({name:'too-large.md',mimeType:'text/markdown',buffer:Buffer.alloc(8*1024*1024+1,65)});
  await expect(page.getByRole('status')).toContainText('单个文件不能超过 8 MB');
  assert.equal((await tasks()).length,2);
  pass('oversize_import_does_not_create_tasks');
  await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);pass('mobile_and_browser_errors');
  await writeFile(path.join(output,'result.json'),JSON.stringify({status:'PASSED',checks},null,2));
  console.log(JSON.stringify({status:'PASSED',checks}));
} finally {await browser?.close();await app.close();await rm(data,{recursive:true,force:true});}
