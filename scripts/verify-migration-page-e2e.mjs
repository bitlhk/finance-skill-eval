/** Browser acceptance for the Runtime Builder boundary: migration generates, then stops before validation. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {zipSync,strToU8} from 'fflate';
import {chromium,expect} from '@playwright/test';
import {createEvaluationService} from '../dist/service/server.js';

const root=process.cwd(),data=await mkdtemp(path.join(os.tmpdir(),'runtime-builder-ui-')),token='runtime-builder-ui';
const source='---\nname: runtime-builder-demo\nversion: 1.0.0\ndescription: Runtime Builder boundary\n---\nRuntime provides read_document(path).\n';
const analyzer=async input=>({status:'PRODUCED',payload:{status:'PRODUCED',skill:{status:'COMPLIANT',findings:[]},tools:[],
  runtimeCapabilities:[{name:'read_document',reason:'源 Runtime 的独立文件读取能力',usageContract:'path:string -> string',consumerTools:[],
    evidence:[{path:'SKILL.md',snippet:'Runtime provides read_document(path).'}]}],dependencyAnalysis:{dependencies:[],chains:[]}},
  scanner:{scannerDigest:'a'.repeat(64),coverage:Object.keys(input.files).map(file=>({path:file,status:'TEXT_INSPECTED'}))}});
const implementer=async()=>({status:'PRODUCED',payload:{tools:[],runtimeToolConfig:{context:{},providers:{},tools:{}}},files:{}});
const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,publicDirectory:path.join(root,'web-dist'),accessToken:token,publicDemo:false,migrationAnalyzer:analyzer,migrationImplementer:implementer});
let browser;
try{
  const url=await app.listen({host:'127.0.0.1',port:0});
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'});
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.goto(url);await page.getByLabel('访问令牌').fill(token);await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.getByRole('button',{name:'新建迁移',exact:true}).click();
  await page.locator('input[type=file][multiple]').setInputFiles({name:'runtime-builder.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'SKILL.md':strToU8(source)}))});
  const blocker=page.locator('.diagnosis-harness');await expect(blocker).toContainText('需要 Runtime Harness 改造',{timeout:30000});
  await expect(blocker).toContainText('运行验证前需先完成 Runtime 适配与登记');await expect(page.getByRole('button',{name:'下载改造需求 YAML',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'确认方案，进入生成',exact:true}).click();
  await page.getByRole('button',{name:'开始生成',exact:true}).click();
  await expect(page.locator('.stage-actions').getByRole('button',{name:'Runtime 适配与登记',exact:true})).toBeVisible({timeout:30000});
  await page.locator('.stage-actions').getByRole('button',{name:'Runtime 适配与登记',exact:true}).click();
  await expect(page.getByRole('heading',{name:'Runtime 适配与登记',exact:true})).toBeVisible();
  await expect(page.getByText('等待 Agent Builder',{exact:true})).toBeVisible();
  const navigation=page.getByLabel('迁移步骤');await expect(navigation.getByRole('button',{name:'验证能否运行',exact:true})).toBeDisabled();
  console.log('PASS migration generates and stops at the Runtime adaptation boundary.');
}finally{await browser?.close();await app.close();await rm(data,{recursive:true,force:true});}
