/** Recorded analysis, real UI/service: incomplete tools must not reach generation. */
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {createEvaluationService} from '../dist/service/server.js';

const output=path.resolve(process.env.MIGRATION_GUARD_OUTPUT);
await mkdir(output,{recursive:false,mode:0o700});
let generated=0;
const token='isolated-incomplete-gate';
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:path.join(output,'data'),publicDirectory:path.resolve('web-dist'),
  publicDemo:false,accessToken:token,
  migrationAnalyzer:async()=>({status:'PRODUCED',payload:{status:'PRODUCED',skill:{status:'NON_COMPLIANT',findings:[]},
    tools:[{name:'declared_lookup',sourcePaths:['SKILL.md'],language:null,portability:'INCOMPLETE',recommendedForm:'MCP',
      recommendationReason:'No implementation or contract supplied',evidence:[{path:'SKILL.md',snippet:'Call declared_lookup.'}],findings:[]}],
    dependencyAnalysis:{dependencies:[],chains:[{toolName:'declared_lookup',nodes:[{id:'declared',title:'Declared external tool',detail:'Declaration only; no implementation or contract supplied',dependencyKeys:[],evidence:[{path:'SKILL.md',snippet:'Call declared_lookup.'}]}],edges:[]}]}},scanner:{scannerDigest:'a'.repeat(64),coverage:[{path:'SKILL.md',status:'TEXT_INSPECTED'}]}}),
  migrationImplementer:async()=>{generated++;throw Error('Generator must not be called');}});
let browser;
try{
  const url=await app.listen({host:'127.0.0.1',port:0});
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto(url);await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
  await page.getByRole('button',{name:'新建迁移',exact:true}).click();
  await page.locator('input[type=file][multiple]').setInputFiles({name:'incomplete.md',mimeType:'text/markdown',
    buffer:Buffer.from('---\nname: incomplete\nversion: 1.0.0\ndescription: Isolated gate fixture\n---\nCall declared_lookup.\n')});
  await expect(page.getByRole('button',{name:'确认方案，进入生成',exact:true})).toBeEnabled({timeout:30000});
  await page.getByRole('button',{name:'确认方案，进入生成',exact:true}).click();
  await expect(page.getByRole('button',{name:'开始生成',exact:true})).toBeDisabled();
  await expect(page.getByText(/工具实现或合同不完整/).first()).toBeVisible();
  const headers={authorization:'Bearer '+token,'content-type':'application/json'};
  const projects=await (await fetch(url+'/api/migrations',{headers})).json();
  const response=await fetch(`${url}/api/migrations/${projects[0].id}/generate`,{method:'POST',headers,
    body:JSON.stringify({baseAssetId:projects[0].source.assetId})});
  assert.equal(response.status,409);assert.equal(generated,0);
  await page.screenshot({path:path.join(output,'desktop.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:path.join(output,'mobile.png'),fullPage:true});
  await writeFile(path.join(output,'report.json'),JSON.stringify({status:'PASS',scope:'RECORDED_ANALYSIS_REAL_UI_SERVICE',
    checks:['incomplete dependency shown','generation disabled','direct generation API rejected','zero generator calls'],realModel:false},null,2));
}finally{await browser?.close();await app.close();}
