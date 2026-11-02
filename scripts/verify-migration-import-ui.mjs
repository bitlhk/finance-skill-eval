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
  const newTask=async()=>{
    await page.getByRole('button',{name:'新建迁移',exact:true}).click();
    await expect(page.getByRole('button',{name:'上传工程 ZIP',exact:true})).toBeVisible();
    await expect(page.getByLabel('添加依赖文件',{exact:true})).toHaveCount(0);
    await expect(page.getByRole('button',{name:'导入 Skill 文件',exact:true})).toHaveCount(0);
  };
  const input=()=>page.locator('.bundle-panel input[type=file]');
  await newTask();
  await input().setInputFiles({name:'broken.zip',mimeType:'application/zip',buffer:Buffer.from('broken')});
  await expect(page.locator('.bundle-upload').getByRole('alert')).toBeVisible();
  assert.equal((await tasks()).length,0);
  pass('invalid_project_does_not_create_task');
  await input().setInputFiles(zip({'skill.md':source('lowercase')},'lowercase.zip'));
  await expect(page.locator('.bundle-upload').getByRole('alert')).toContainText('lowercase.zip 导入失败');
  await expect(page.locator('.bundle-upload').getByRole('alert')).toContainText('大写 SKILL.md');
  assert.equal((await tasks()).length,0);
  pass('strict_entry_name_error_is_shown_beside_upload_control');

  const project={'project/features/a/SKILL.md':source('a'),'project/features/b/SKILL.md':source('b'),
    'project/src/tool.py':'print(2)','project/shared/business-rules.json':'{"limit":100}',
    'project/requirements.txt':'Pillow==11.0.0','project/resources/example.txt':'sample'};
  await input().setInputFiles(zip(project,'my-project.zip'));
  await expect(page.getByRole('button',{name:'开始诊断',exact:true})).toBeVisible();
  const records=await tasks();assert.equal(records.length,1);
  const whole=records[0];assert.equal(whole.source.members.length,2);
  for(const [name,content] of Object.entries(project)){
    const file=await fetch(url+'/api/migration-tasks/'+whole.id+'/file?path='+encodeURIComponent(name),{headers:{authorization:'Bearer '+token}});
    assert(file.ok);assert.equal((await file.json()).content,content);
  }
  pass('one_project_zip_preserves_skills_sources_dependencies_resources_and_paths');
  await page.getByRole('button',{name:'返回迁移列表',exact:true}).click();
  await newTask();
  await input().setInputFiles({name:'too-large.zip',mimeType:'application/zip',buffer:Buffer.alloc(8*1024*1024+1,65)});
  await expect(page.locator('.bundle-upload').getByRole('alert')).toBeVisible();
  assert.equal((await tasks()).length,1);
  pass('oversize_project_does_not_create_task');
  await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);pass('mobile_and_browser_errors');
  await writeFile(path.join(output,'result.json'),JSON.stringify({status:'PASSED',checks},null,2));
  console.log(JSON.stringify({status:'PASSED',checks}));
} finally {await browser?.close();await app.close();await rm(data,{recursive:true,force:true});}
