import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium, expect } from '@playwright/test';
import { unzipSync } from 'fflate';
import { createEvaluationService } from '../dist/service/server.js';

const data = await mkdtemp(path.join(os.tmpdir(), 'history-ui-'));
const output = path.resolve('reports/history-ui'); await mkdir(output, {recursive:true});
const id='bundle-aabb',candidate='candidate-ccdd';
const task={schemaVersion:'finance.skill-migration.bundle.v1',id,name:'历史采购审核',goal:'复核旧任务的采购预算与证据',target:'旧 Runtime',createdAt:'2026-10-19T00:00:00Z',
  source:{members:[{skillId:'purchase',skillFile:'SKILL.md'}]},analysis:{summary:'保留的历史分析结果'},
  candidates:[{id:candidate,summary:'旧版候选',createdAt:'2026-10-19T01:00:00Z'}],
  attempts:[{kind:'ACCEPT',status:'RUNNING',message:'历史进度',startedAt:'2026-10-19T01:00:00Z'}],
  runs:[{id:'run-old',status:'PASSED',createdAt:'2026-10-19T02:00:00Z',cases:[{id:'case-1',passed:true,reason:'当时预算计算正确',evidence:{output:'保留的历史执行证据'}}]}]};
const written=[];
async function put(relative,value){const file=path.join(data,relative);await mkdir(path.dirname(file),{recursive:true});const bytes=JSON.stringify(value);await writeFile(file,bytes);written.push([file,bytes]);}
await put(`migration-bundles/tasks/${id}.json`,task);
for(const [revision,content] of [['source','# 原始采购 Skill'],[candidate,'# 历史候选 Skill']])await put(`migration-bundles/snapshots/${id}/${revision}.json`,{digest:'a'.repeat(64),files:{'SKILL.md':Buffer.from(content).toString('base64')}});
await put('environments/env-old.json',{environmentId:'env-old',name:'旧协议环境',type:'runtime_launcher',delivery:{evalConformance:{instanceSchemaVersion:'finance.skill-eval.runtime-instance.v2',status:'PASSED'}}});
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:data,publicDirectory:path.resolve('web-dist'),accessToken:'history-ui-only',publicDemo:false});
app.log.level='error';
let browser;
try{
  const origin=await app.listen({host:'127.0.0.1',port:0});
  const edge='C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || (existsSync(edge)?edge:undefined)});
  const page=await browser.newPage({viewport:{width:1366,height:900}}),errors=[],writes=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',r=>{if(!['GET','HEAD'].includes(r.method()))writes.push(r.method()+' '+new URL(r.url()).pathname)});
  await page.addInitScript(()=>localStorage.setItem('finance-eval-token','history-ui-only'));
  await page.goto(origin);
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
  const history=page.getByRole('region',{name:'历史迁移任务',exact:true});
  await expect(history.getByText('历史采购审核',{exact:true})).toBeVisible();
  await history.getByRole('button',{name:'查看历史',exact:true}).click();
  await expect(history.getByText('只读历史 · 无法继续执行',{exact:true})).toBeVisible();
  await expect(history.getByText('保留的历史分析结果',{exact:true})).toBeVisible();
  await history.getByText('验收 1 · 当时通过',{exact:false}).click();
  await expect(history.getByText('当时预算计算正确',{exact:true})).toBeVisible();
  await history.getByText('历史执行证据',{exact:true}).click();
  await expect(history.getByText('保留的历史执行证据',{exact:false}).first()).toBeVisible();
  await history.getByLabel('选择历史版本').selectOption('source');
  await history.getByRole('button',{name:'SKILL.md',exact:true}).click();
  await expect(history.getByLabel('历史文件内容')).toHaveText('# 原始采购 Skill');
  await history.getByLabel('选择历史版本').selectOption(candidate);
  await history.getByRole('button',{name:'SKILL.md',exact:true}).click();
  await expect(history.getByLabel('历史文件内容')).toHaveText('# 历史候选 Skill');
  assert.equal(await history.getByRole('button',{name:/继续处理|开始验收|生成迁移结果/}).count(),0);
  await history.screenshot({path:path.join(output,'task-desktop.png')});
  const download=page.waitForEvent('download');await history.getByRole('button',{name:'下载历史留档',exact:true}).click();
  const zip=unzipSync(await readFile(await(await download).path()));
  assert.equal(Buffer.from(zip['record.json']).toString(),JSON.stringify(task));
  assert(zip['snapshots/source.json']);assert(zip[`snapshots/${candidate}.json`]);
  for(const width of [390,320]){await page.setViewportSize({width,height:844});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);await history.screenshot({path:path.join(output,`task-${width}.png`)});}
  await page.setViewportSize({width:1366,height:900});
  await page.getByRole('button',{name:'测试环境',exact:true}).click();
  const environments=page.getByRole('region',{name:'历史环境登记',exact:true});
  await environments.getByRole('button',{name:'查看历史',exact:true}).click();
  await expect(environments.getByText('只读历史 · 无法继续执行',{exact:true})).toBeVisible();
  await expect(environments.getByText('不能证明其符合当前 Runtime 协议',{exact:false})).toBeVisible();
  await environments.screenshot({path:path.join(output,'environment-desktop.png')});
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
  for(const [file,bytes] of written)assert.equal(await readFile(file,'utf8'),bytes);
  await writeFile(path.join(output,'report.json'),JSON.stringify({status:'PASSED',scope:'ISOLATED_FIXTURE_NO_MODEL_CALLS',checks:['historical task and environment visible','read-only reason and next step','historical analysis and evidence','source and candidate file preview','byte-identical history download','desktop and 390/320 layouts','no mutations or browser errors','stored originals unchanged']},null,2));
  console.log('History UI verification passed');
}finally{await browser?.close();await app.close();await rm(data,{recursive:true,force:true});}
