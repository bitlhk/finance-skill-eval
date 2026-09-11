import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,request} from '@playwright/test';
const origin=process.argv[2],out=path.resolve(process.argv[3]);
if(!origin||!process.env.MIGRATION_DEPLOY_TOKEN_FILE)throw new Error('Explicit origin and token file required');
await mkdir(out,{recursive:true,mode:0o700});
const token=(await readFile(process.env.MIGRATION_DEPLOY_TOKEN_FILE,'utf8')).trim();
const context=await request.newContext({ignoreHTTPSErrors:true,baseURL:origin});
const headers={'X-Migration-Authorization':'Bearer '+token};
const browser=await chromium.launch({headless:true});let report;const checks=[];
try{
  assert.equal((await context.get('api/migrations')).status(),401);
  assert.equal((await context.get('api/migrations',{headers:{Authorization:'Bearer public-ingress-is-not-private-authority'}})).status(),401);checks.push('private_header_boundary_preserved');
  const catalog=await (await context.get('api/catalog',{headers})).json();const source=catalog.uploadedSkills.find(a=>a.skillId==='long_term_borrowings_analysis'&&a.version==='0.0.0-upload');assert(source,'PF source not found; do not modify other projects');
  const response=await context.post('api/migrations',{headers,data:{sourceAssetId:source.assetId,name:'浦发方法结构 · 模拟目标验证 20260911'}});assert.equal(response.status(),200);const project=await response.json();
  const page=await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(origin);await page.getByLabel('访问令牌').fill(token);await page.getByRole('button',{name:'进入工作区',exact:true}).click();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.locator('.migration-project').filter({hasText:project.name}).click();
  await page.getByRole('button',{name:'选择迁移目标'}).click();await page.getByLabel('执行方式').selectOption('pf-method-synthetic-v1');await page.getByRole('checkbox').check();await page.getByRole('button',{name:project.candidate?'重新生成候选':'生成迁移候选',exact:true}).click();await page.getByText('新增 · migration-generated/neutral-contract.json',{exact:true}).waitFor();
  await page.locator('.migration-panel').screenshot({path:path.join(out,'mapping.png')});checks.push('deployed_candidate_generated_from_selected_source');
  await page.getByRole('button',{name:'检查验证条件',exact:true}).click();await page.getByRole('button',{name:'运行当前候选'}).click();
  const end=Date.now()+600000;do{await new Promise(r=>setTimeout(r,1500));report=await(await context.get(`api/migrations/${project.id}/report`,{headers})).json();}while((!report.targetRuns?.length||report.targetRuns.at(-1).status==='RUNNING')&&Date.now()<end);
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2),{mode:0o600});assert.equal(report.verification.targetExecution,'PASSED');
  await page.getByRole('heading',{name:/当前候选 · 模拟目标执行通过/}).waitFor();await page.locator('.migration-panel').screenshot({path:path.join(out,'verified-desktop.png')});checks.push('deployed_real_model_target_passed');
  await page.setViewportSize({width:390,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,'verified-mobile.png'),fullPage:true});checks.push('mobile_fits');
  await page.reload();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.locator('.migration-project').filter({hasText:project.name}).click();await page.getByRole('button',{name:'3 目标验证',exact:true}).click();await page.getByRole('heading',{name:/当前候选 · 模拟目标执行通过/}).waitFor();checks.push('deployed_refresh_restores_evidence');
  assert.deepEqual(errors,[]);checks.push('no_browser_errors');
}finally{await writeFile(path.join(out,'checks.json'),JSON.stringify({checks,origin,projectId:report?.project?.id,mode:'DEPLOYED_PRIVATE_ORIGIN_REAL_MODEL_SYNTHETIC_PORTS',gatewaySsoHumanSessionVerified:false,originalNativeEquivalent:false},null,2),{mode:0o600});await browser.close();await context.dispose();}
console.log(JSON.stringify({checks,projectId:report.project.id,digest:report.project.candidate.artifactSha256}));
