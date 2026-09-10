import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { chromium, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import { createEvaluationService } from '../dist/service/server.js';

const output=path.resolve(process.argv[2]||'reports/migration-ui');await mkdir(output,{recursive:true});
const data=await mkdtemp(path.join(os.tmpdir(),'migration-ui-'));
const token='isolated-ui-test-only';
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:data,publicDirectory:path.resolve(process.env.MIGRATION_TEST_WEB_DIR||'web-dist'),accessToken:token,publicDemo:false});
const headers={authorization:`Bearer ${token}`};
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH,headless:true});
const checks=[];
let proxy;
try {
  let address=await app.listen({host:'127.0.0.1',port:0});
  const prefix=process.env.MIGRATION_TEST_PREFIX;
  if(prefix){
    assert(/^\/[a-z-]+\/$/.test(prefix));const target=address;
    proxy=http.createServer((req,res)=>{
      if(!req.url.startsWith(prefix)){res.statusCode=404;res.end();return;}
      const upstream=http.request(new URL(req.url.slice(prefix.length-1),target),{method:req.method,headers:req.headers},response=>{
        res.writeHead(response.statusCode,response.headers);response.pipe(res);
      });upstream.on('error',()=>{res.statusCode=502;res.end();});req.pipe(upstream);
    });
    await new Promise(r=>proxy.listen(0,'127.0.0.1',r));address=`http://127.0.0.1:${proxy.address().port}${prefix}`;
  }
  for(const version of ['1.0.0','1.0.1']){
    const r=await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:Buffer.from(zipSync({'SKILL.md':strToU8(`---\nname: synthetic-readonly\nversion: ${version}\n---\nDescribe known assets; missing is not zero.`)}))});assert.equal(r.statusCode,200);
  }
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(address);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  checks.push('private_workspace_login');
  await page.getByRole('button',{name:'Skill 资产',exact:true}).click();
  await page.locator('.migration-panel').getByLabel('原始 Skill').selectOption({label:'synthetic-readonly@1.0.0'});
  await page.getByRole('button',{name:'建立迁移项目'}).click();
  await page.locator('.migration-panel').getByText('SHA ',{exact:false}).waitFor();checks.push('source_project_created');
  await page.getByRole('button',{name:'2 依赖与改写'}).click();
  await page.getByRole('button',{name:'检查文件与待补材料'}).click();
  await page.getByText('依赖盘点',{exact:true}).click();
  await page.locator('.migration-panel pre').filter({hasText:'BUILDER_JAVA_HOST_ADAPTER_NOT_CONNECTED'}).waitFor();checks.push('missing_materials_visible');
  await page.getByLabel('规范化候选').selectOption({label:'synthetic-readonly@1.0.1'});
  await page.getByLabel('改写依据与未解决依赖').fill('合成回归；只修改格式，不改变业务方法。');
  await page.getByRole('button',{name:'保存候选引用'}).click();
  await page.getByRole('button',{name:'检查文件与待补材料'}).click();
  await expect(page.getByLabel('候选方法正文')).toHaveValue(/1\.0\.1/);
  const method=await page.getByLabel('候选方法正文').inputValue();
  await page.getByLabel('候选方法正文').fill(method.replace('1.0.1','1.0.2'));
  await page.getByRole('button',{name:'保存为新版本'}).click();
  await expect(page.getByLabel('规范化候选').locator('option:checked')).toHaveText('synthetic-readonly@1.0.2');
  checks.push('edited_candidate_is_new_version');
  await page.getByRole('button',{name:'3 对照验证'}).click();
  assert(await page.getByRole('button',{name:'运行成对实验'}).isDisabled());checks.push('missing_runtime_cannot_run');
  await page.getByLabel('对照阶段').selectOption('BC');
  assert(await page.getByLabel('右侧 Runtime').isEnabled());checks.push('per_side_runtime_selection');
  await page.getByText('项目试卷',{exact:true}).click();
  const testCase=id=>({caseId:id,name:id,prompt:'Describe missing information',evaluationGoal:'Synthetic protocol case',requiredTools:[],
    rubric:[{criterionId:'missing',label:'Missing',description:'No invented facts',dimension:'business_completeness',weight:1,allOf:['missing']}]});
  await page.getByLabel('试卷 JSON').fill(JSON.stringify({summary:'Synthetic private suite',cases:[testCase('DEV')],holdoutCases:[testCase('HOLDOUT')]}));
  await page.getByRole('button',{name:'冻结新试卷'}).click();
  await expect(page.getByLabel('固定题集').locator('option:checked')).toHaveText('Synthetic private suite');checks.push('project_suite_created');
  await page.screenshot({path:path.join(output,'comparison-desktop.png'),fullPage:true});
  await page.getByRole('button',{name:'5 发布装配'}).click();
  await page.getByText('正式发布关闭。',{exact:false}).waitFor();
  const download=page.waitForEvent('download');await page.getByRole('button',{name:'导出候选草稿'}).click();
  await (await download).saveAs(path.join(output,'synthetic-draft.zip'));checks.push('draft_export_not_release');
  await page.reload();await page.getByRole('button',{name:'Skill 资产',exact:true}).click();
  await expect(page.getByLabel('已有项目').locator('option')).toHaveCount(2);checks.push('project_survives_refresh');
  await page.setViewportSize({width:390,height:900});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));checks.push('mobile_no_overflow');
  await page.screenshot({path:path.join(output,'migration-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);checks.push('no_browser_errors');
  await writeFile(path.join(output,'checks.json'),JSON.stringify({mode:'SYNTHETIC_UI_REAL_SERVICE',checks},null,2));
} finally {await browser.close();if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}await app.close();await rm(data,{recursive:true,force:true});}
