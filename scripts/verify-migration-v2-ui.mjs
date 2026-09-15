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

async function migrationArchive(directory){
  const files={};
  for(const name of await readdir(directory,{recursive:true})){
    const normalized=name.replaceAll('\\','/'),segments=normalized.split('/');
    if(segments.includes('__pycache__')||segments.some(segment=>segment.startsWith('.venv'))||normalized.endsWith('.pyc'))continue;
    const content=await readFile(path.join(directory,name)).catch(error=>error.code==='EISDIR'?null:Promise.reject(error));
    if(!content)continue;
    const target=normalized==='SKILL.md'||normalized.startsWith('references/')||normalized.startsWith('assets/')||normalized.startsWith('scripts/')
      ? `skill/${normalized}`
      : `tool/${normalized}`;
    files[target]=content;
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

const migrationSources={
  calculate_acceptance_total:'from decimal import Decimal, ROUND_HALF_UP\nimport json, sys\ndef calculate_acceptance_total(subtotal: str, tax_rate: str):\n    amount=Decimal(subtotal); rate=Decimal(tax_rate); tax=(amount*rate).quantize(Decimal("0.01"),rounding=ROUND_HALF_UP)\n    return {"status":"ok","subtotal":f"{amount:.2f}","tax_rate":f"{rate:.2f}","tax_amount":f"{tax:.2f}","total":f"{amount+tax:.2f}"}\nif __name__ == "__main__":\n    json.dump(calculate_acceptance_total(**json.load(sys.stdin)),sys.stdout)\n',
  get_acceptance_order:'import json, sys\nORDERS={"ORDER-001":{"order_id":"ORDER-001","currency":"CNY","subtotal":"100.00","tax_rate":"0.06","approved":True}}\ndef get_acceptance_order(order_id: str):\n    order=ORDERS.get(order_id)\n    return {"status":"ok",**order} if order else {"status":"unavailable","order_id":order_id}\nif __name__ == "__main__":\n    json.dump(get_acceptance_order(**json.load(sys.stdin)),sys.stdout)\n',
};
const migrationModel=()=>({configured:true,model:{providerId:'acceptance',modelId:'semantic-migration',parameters:{}},adapter:{adapterId:'acceptance-migration-model',async complete(request){
  const body=JSON.parse(request.messages.at(-1).content),implementations=body.tools.map(tool=>tool.targetLanguage==='java'
    ?{toolId:tool.toolId,toolName:tool.name,language:'java',entrypoint:`${tool.requiredJavaClass}.java`,entryClass:tool.requiredJavaClass,files:[{path:`${tool.requiredJavaClass}.java`,content:`package com.finance.migration.business; import java.util.LinkedHashMap; import java.util.Map; public final class ${tool.requiredJavaClass} { public static Object execute(Map<String,Object> arguments) throws Exception { return new LinkedHashMap<>(arguments); } }`}],dependencies:[],smokeInput:{},explanation:'Acceptance pure Java semantic migration'}
    :{toolId:tool.toolId,toolName:tool.name,language:'python',entrypoint:'main.py',files:[{path:'main.py',content:migrationSources[tool.name]}],dependencies:[],smokeInput:{subtotal:'100.00',tax_rate:'0.06'},explanation:'Acceptance Python Script migration'});
  return {modelId:'semantic-migration',content:JSON.stringify({implementations})};
}}});
const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,publicDirectory:path.join(root,'web-dist'),accessToken:token,publicDemo:false,migrationModel});
let browser;
try{
  const mcpBase=await listen(mcp),mcpEndpoint=`${mcpBase}/mcp`;
  const serviceUrl=await app.listen({host:'127.0.0.1',port:0});
  const headers={authorization:`Bearer ${token}`,'content-type':'application/zip'};
  const legacyZip=await migrationArchive(path.join(root,'acceptance/openjiuwen-portability/legacy-skill'));
  const credentialPattern=/(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\n]{8,}["']/i;
  for(const [name,content] of Object.entries(unzipSync(legacyZip))){
    const match=Buffer.from(content).toString().match(credentialPattern);
    if(match)throw new Error(`Acceptance fixture triggers credential scan in ${name}: ${match[0].slice(0,40)}`);
  }

  const executablePath=process.env.CHROMIUM_PATH||'C:\\Progra~1\\Google\\Chrome\\Application\\chrome.exe';
  browser=await chromium.launch({executablePath,headless:true});
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});
  const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(serviceUrl);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
  await page.getByRole('button',{name:'新建迁移',exact:true}).click();
  await page.locator('input[type=file]').setInputFiles({name:'legacy-skill.zip',mimeType:'application/zip',buffer:legacyZip});
  await page.getByRole('heading',{name:'检查结果',exact:true}).waitFor();
  await expect(page.getByText('依赖原来的运行框架',{exact:false})).toHaveCount(2);
  checks.push('legacy_skill_uploaded_and_inspected');

  await page.getByRole('button',{name:'选择迁移方式',exact:true}).click();
  await page.locator('article').filter({hasText:'calculate_acceptance_total'}).getByLabel('迁移方式').selectOption('MIGRATE_TO_SCRIPT');
  await page.locator('article').filter({hasText:'get_acceptance_order'}).getByLabel('迁移方式').selectOption('MIGRATE_TO_MCP');
  await page.getByRole('button',{name:'确认并生成方案',exact:true}).click();
  await page.getByRole('button',{name:'生成迁移后的 Skill 包',exact:true}).click();
  await expect(page.getByText('工具已经可以试运行。',{exact:true})).toHaveCount(2);
  await expect(page.getByText('已生成工具工程，还需要接入原有业务代码。',{exact:true})).toHaveCount(0);
  checks.push('mixed_choices_generated_with_business_code');

  await page.getByRole('button',{name:'验证能否运行',exact:true}).click();
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
  assert(exported['skill/SKILL.md']);assert(exported['skill/scripts/calculate_acceptance_total.py']);
  assert(exported['mcp/pom.xml']);assert(exported['mcp/Dockerfile']);
  assert(exported['mcp/src/main/java/com/finance/migration/business/GetAcceptanceOrderBusiness.java']);
  assert(!Object.keys(exported).some(name=>name.startsWith('mcp/')&&name.endsWith('.py')));
  assert(!exported['migration-manifest.json']);assert(!exported['migration-report.json']);
  const script=Buffer.from(exported['skill/scripts/calculate_acceptance_total.py']).toString();
  assert.match(script,/Decimal\(subtotal\)/);assert.doesNotMatch(script,/agentscope\.tool/);
  await page.getByRole('status').filter({hasText:'下载已开始'}).waitFor();
  checks.push('validated_candidate_downloaded');
  assert.deepEqual(errors,[]);checks.push('no_browser_errors');
  process.stdout.write(`${JSON.stringify({mode:'REAL_SERVICE_HEADLESS_CHROME',checks},null,2)}\n`);
}finally{
  if(browser)await browser.close();
  mcp.closeAllConnections();if(mcp.listening)await close(mcp);
  await app.close();await Promise.all([rm(data,{recursive:true,force:true}),rm(downloads,{recursive:true,force:true})]);
}
