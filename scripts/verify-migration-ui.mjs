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
      const forwarded={...req.headers};
      if(process.env.MIGRATION_TEST_PRIVATE_GATEWAY==='true'){
        forwarded.authorization=String(req.headers['x-migration-authorization']||'');
        delete forwarded['x-migration-authorization'];
      }
      const upstream=http.request(new URL(req.url.slice(prefix.length-1),target),{method:req.method,headers:forwarded},response=>{
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
  await page.locator('input[type=file]').setInputFiles({name:'synthetic.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({
    'SKILL.md':strToU8('---\nname: synthetic-auto-diagnosis\nversion: 1.0.0\n---\nDescribe known facts.'),
    'helper.py':strToU8('from agentscope.tool import ToolResponse\nfrom .missing import read\n')}))});
  await page.getByRole('heading',{name:'发现框架或宿主绑定'}).waitFor();checks.push('upload_automatically_diagnosed');
  await page.getByRole('heading',{name:'相对导入模块未随包提供'}).waitFor();checks.push('missing_materials_visible');
  await page.locator('.migration-panel').screenshot({path:path.join(output,'diagnosis-desktop.png')});
  await page.getByRole('button',{name:'选择迁移目标'}).click();
  await page.getByRole('button',{name:'生成迁移候选',exact:true}).click();
  await page.getByText('新增 · migration-generated/OpenJiuwenMigrationTool.java',{exact:true}).waitFor();checks.push('real_adapter_candidate_generated');
  await page.getByText('手工编辑与已有候选',{exact:true}).click();
  await page.getByRole('button',{name:'检查文件与待补材料'}).click();
  await expect(page.getByLabel('候选方法正文')).toHaveValue(/migration\.1/);
  const method=await page.getByLabel('候选方法正文').inputValue();
  await page.getByLabel('候选方法正文').fill(method+'\nAlways retain sources.');
  await page.getByRole('button',{name:'保存为新版本'}).click();
  await expect(page.getByLabel('规范化候选').locator('option:checked')).toHaveText(/migration\.2/);
  checks.push('edited_candidate_is_new_version');
  await page.getByRole('button',{name:'检查验证条件',exact:true}).click();
  await page.getByText('候选已修改，旧版本验证不能用于当前版本。',{exact:true}).waitFor();checks.push('stale_validation_not_reused');
  await page.getByText('工程对照配置（已有兼容 Runtime）',{exact:true}).click();
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
  await page.getByRole('button',{name:'6 发布'}).click();
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
