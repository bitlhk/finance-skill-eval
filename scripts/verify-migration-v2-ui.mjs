import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { unzipSync, zipSync } from 'fflate';
import { createEvaluationService } from '../dist/service/server.js';

const root=process.cwd();
const data=await mkdtemp(path.join(os.tmpdir(),'migration-v2-ui-'));
const downloads=await mkdtemp(path.join(os.tmpdir(),'migration-v2-download-'));
const token='migration-v2-ui-test';
const checks=[];

async function archive(directory){
  const files={};
  for(const name of await readdir(directory,{recursive:true})){
    const segments=name.split(/[\\/]/);
    if(segments.includes('__pycache__')||segments.some(segment=>segment.startsWith('.venv'))||name.endsWith('.pyc'))continue;
    const content=await readFile(path.join(directory,name)).catch(error=>error.code==='EISDIR'?null:Promise.reject(error));
    if(content)files[name.replaceAll('\\','/')]=content;
  }
  return Buffer.from(zipSync(files));
}

function listen(server){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(`http://127.0.0.1:${server.address().port}`));});}
function close(server){return new Promise(resolve=>server.close(resolve));}

const mcp=http.createServer(async(req,res)=>{
  if(req.method==='DELETE'){res.statusCode=200;res.end();return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  const body=raw?JSON.parse(raw):{};
  if(body.method==='notifications/initialized'){res.statusCode=202;res.end();return;}
  const result=body.method==='initialize'
    ? {protocolVersion:'2025-06-18',serverInfo:{name:'migration-v2-ui-mcp',version:'1.0.0'},capabilities:{tools:{}}}
    : body.method==='tools/list'
      ? {tools:[{name:'get_acceptance_order',description:'Return a fixed order',inputSchema:{type:'object',properties:{order_id:{type:'string'}},required:['order_id']}}]}
      : body.method==='tools/call'
        ? {content:[{type:'text',text:'ORDER-001'}],structuredContent:{order_id:'ORDER-001',currency:'CNY',subtotal:'100.00',tax_rate:'0.06',approved:true}}
        : {};
  res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:body.id,result}));
});

const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,publicDirectory:path.resolve(process.env.MIGRATION_TEST_WEB_DIR||'web-dist'),accessToken:token,publicDemo:false});
let browser,proxy;
try{
  const mcpBase=await listen(mcp),mcpEndpoint=`${mcpBase}/mcp`;
  let serviceUrl=await app.listen({host:'127.0.0.1',port:0});
  const prefix=process.env.MIGRATION_TEST_PREFIX;
  if(prefix){
    assert(/^\/[a-z-]+\/$/.test(prefix));const target=serviceUrl;
    proxy=http.createServer((req,res)=>{
      if(!req.url.startsWith(prefix)){res.writeHead(404);res.end();return;}
      const forwarded={...req.headers};
      if(process.env.MIGRATION_TEST_PRIVATE_GATEWAY==='true'){
        forwarded.authorization=String(req.headers['x-migration-authorization']||'');
        delete forwarded['x-migration-authorization'];
      }
      const upstream=http.request(new URL(req.url.slice(prefix.length-1),target),{method:req.method,headers:forwarded},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
      upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);
    });
    serviceUrl=(await listen(proxy))+prefix;
  }
  const headers={authorization:`Bearer ${token}`,'content-type':'application/zip'};
  const completedZip=await archive(path.join(root,'acceptance/openjiuwen-portability/skill'));
  const credentialPattern=/(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\n]{8,}["']/i;
  for(const [name,content] of Object.entries(unzipSync(completedZip))){
    const match=Buffer.from(content).toString().match(credentialPattern);
    if(match)throw new Error(`Acceptance fixture triggers credential scan in ${name}: ${match[0].slice(0,40)}`);
  }
  const completed=(await app.inject({method:'POST',url:'/api/skills/upload',headers,payload:completedZip})).json();
  assert.equal(completed.version,'2.0.0');

  const executablePath=process.env.CHROMIUM_PATH;
  browser=await chromium.launch({executablePath,headless:true});
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(serviceUrl);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
  await page.getByRole('button',{name:'新建迁移',exact:true}).click();
  await page.locator('input[type=file]').setInputFiles({name:'legacy-skill.zip',mimeType:'application/zip',buffer:await archive(path.join(root,'acceptance/openjiuwen-portability/legacy-skill'))});
  await page.getByRole('heading',{name:'检查结果',exact:true}).waitFor();
  await expect(page.getByText('依赖原来的运行框架',{exact:false})).toHaveCount(2);
  checks.push('legacy_skill_uploaded_and_inspected');

  await page.getByRole('button',{name:'选择迁移方式',exact:true}).click();
  await page.locator('article').filter({hasText:'calculate_acceptance_total'}).getByLabel('迁移方式').selectOption('MIGRATE_TO_SCRIPT');
  await page.locator('article').filter({hasText:'get_acceptance_order'}).getByLabel('迁移方式').selectOption('MIGRATE_TO_MCP');
  await page.getByRole('button',{name:'确认并生成方案',exact:true}).click();
  await page.getByRole('button',{name:'生成迁移后的 Skill 包',exact:true}).click();
  await page.getByText('上传已经补完业务代码的版本',{exact:true}).click();
  await page.getByLabel('已上传的新版本').selectOption({label:'迁移完成验收 Skill@2.0.0'});
  await page.getByRole('button',{name:'使用这个版本并重新检查',exact:true}).click();
  await page.getByText('工具迁移已完成。',{exact:false}).waitFor();
  checks.push('mixed_choices_and_completed_candidate');

  await page.getByRole('button',{name:'开始验证',exact:true}).click();
  const scriptCard=page.locator('article').filter({hasText:'calculate_acceptance_total'});
  await scriptCard.getByLabel('试运行时传给工具的内容（JSON）').fill('{"subtotal":"100.00","tax_rate":"0.06"}');
  await scriptCard.getByRole('button',{name:'试运行',exact:true}).click();
  await page.getByRole('heading',{name:'calculate_acceptance_total · 验证通过',exact:true}).waitFor();
  const mcpCard=page.locator('article').filter({hasText:'get_acceptance_order'});
  await mcpCard.getByLabel('共享 MCP 服务地址').fill(mcpEndpoint);
  await mcpCard.getByLabel('试运行时传给工具的内容（JSON）').fill('{"order_id":"ORDER-001"}');
  await mcpCard.getByRole('button',{name:'试运行',exact:true}).click();
  await page.getByRole('heading',{name:'get_acceptance_order · 验证通过',exact:true}).waitFor();
  checks.push('script_and_mcp_technical_validation');

  await page.getByRole('button',{name:'7 下载结果',exact:true}).click();
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'下载迁移后的 Skill 包',exact:true}).click();
  const download=await pending,target=path.join(downloads,'migration.zip');await download.saveAs(target);
  const exported=unzipSync(await readFile(target));
  assert(exported['migration-manifest.json']);assert(exported['migration-report.json']);assert(exported['SKILL.md']);
  await page.getByRole('status').filter({hasText:'下载已开始'}).waitFor();
  checks.push('validated_candidate_downloaded');
  assert.deepEqual(errors,[]);checks.push('no_browser_errors');
  await page.setViewportSize({width:390,height:900});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));checks.push('mobile_no_overflow');
  process.stdout.write(`${JSON.stringify({mode:'REAL_SERVICE_HEADLESS_CHROME',checks},null,2)}\n`);
}finally{
  if(browser)await browser.close();
  if(proxy){proxy.closeAllConnections();await close(proxy);}
  mcp.closeAllConnections();if(mcp.listening)await close(mcp);
  await app.close();await Promise.all([rm(data,{recursive:true,force:true}),rm(downloads,{recursive:true,force:true})]);
}
