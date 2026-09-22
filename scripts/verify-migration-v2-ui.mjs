import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { unzipSync, zipSync } from 'fflate';
import { createEvaluationService } from '../dist/service/server.js';

/**
 * Drive the migration UI in a real browser against a real service.
 *
 * The two agents are stood in: A2 (analysis) because reading a package is a judgement no rule can
 * make, and A4 (implementation) because writing the service is the agent's job. Everything else --
 * inspection, decisions, packaging, technical validation, export -- is the platform's own code,
 * which is what this script is here to exercise.
 */
const root=process.cwd();
const data=await mkdtemp(path.join(os.tmpdir(),'migration-v2-ui-'));
const downloads=await mkdtemp(path.join(os.tmpdir(),'migration-v2-download-'));
const token='migration-v2-ui-test';
const checks=[];
// The result is one JSON line at the end, which is the wrong shape for a run that takes an hour:
// with the real agents standing in for the stubs, silence and a hang look identical.
const pass=name=>{checks.push(name);process.stderr.write(`ok ${name}\n`);};

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

function close(server){return new Promise(resolve=>server.close(resolve));}

const SKILL_MD='skill/SKILL.md',TOOL_SOURCE='tool/legacy_runtime_tools.py';

/**
 * What A2 reads out of the fixture Skill. Every claim cites a line that exists in `skill/SKILL.md`:
 * an analysis is worth exactly as much as the place it points at, and the platform drops the rest.
 */
const analysis={status:'PRODUCED',skill:{status:'COMPLIANT',findings:[]},tools:[
  {name:'get_acceptance_order',sourcePaths:[TOOL_SOURCE,SKILL_MD],language:'Python',portability:'RUNTIME_BOUND',
    input:{description:'按订单号查询',schema:{type:'object',properties:{order_id:{type:'string'}},required:['order_id']},path:SKILL_MD,snippet:'Call `get_acceptance_order` with the exact order ID'},
    output:{description:'返回订单的币种、金额与审批状态',schema:{type:'object',properties:{order_id:{type:'string'},currency:{type:'string'},subtotal:{type:'string'},tax_rate:{type:'string'},approved:{type:'boolean'}}},path:SKILL_MD,snippet:'Return the order ID, currency, subtotal, tax amount, and total'},
    samples:[{input:{order_id:'ORDER-001'},path:SKILL_MD,snippet:'Call `get_acceptance_order` with the exact order ID'}],
    evidence:[],findings:[],recommendedForm:'MCP',
    recommendationReason:'注册在旧 Agent Runtime 里，需要一个可被不同环境调用的服务'},
  {name:'calculate_acceptance_total',sourcePaths:[TOOL_SOURCE,SKILL_MD],language:'Python',portability:'RUNTIME_BOUND',
    input:{description:'用订单的小计与税率算总额',schema:{type:'object',properties:{subtotal:{type:'string'},tax_rate:{type:'string'}},required:['subtotal','tax_rate']},path:SKILL_MD,snippet:'Call `calculate_acceptance_total` with the returned subtotal and tax rate'},
    output:{description:'返回小计、税额与合计',schema:{type:'object',properties:{status:{type:'string'},subtotal:{type:'string'},tax_rate:{type:'string'},tax_amount:{type:'string'},total:{type:'string'}}},path:SKILL_MD,snippet:'Return the order ID, currency, subtotal, tax amount, and total'},
    samples:[{input:{subtotal:'100.00',tax_rate:'0.06'},path:SKILL_MD,snippet:'Call `calculate_acceptance_total` with the returned subtotal and tax rate'}],
    evidence:[],findings:[],recommendedForm:'SCRIPT',
    recommendationReason:'纯计算，没有 runtime 依赖'},
]};
analysis.dependencyAnalysis={dependencies:[],chains:analysis.tools.map(tool=>({toolName:tool.name,nodes:[{id:'entry',title:'业务入口',detail:tool.recommendationReason,dependencyKeys:[],evidence:[{path:tool.input.path,snippet:tool.input.snippet}]}],edges:[]}))};
// Coverage comes from the scanner, not from the agent's own account of itself.
const scanner={scannerDigest:'a'.repeat(64),coverage:[{path:SKILL_MD,status:'TEXT_INSPECTED'},{path:TOOL_SOURCE,status:'AST_PARSED'}]};
const migrationAnalyzer=async()=>({status:'PRODUCED',payload:analysis,scanner});

const scriptSource='from decimal import Decimal, ROUND_HALF_UP\nimport json, sys\n\ndef calculate_acceptance_total(subtotal: str, tax_rate: str):\n    amount=Decimal(subtotal); rate=Decimal(tax_rate); tax=(amount*rate).quantize(Decimal("0.01"),rounding=ROUND_HALF_UP)\n    return {"status":"ok","subtotal":f"{amount:.2f}","tax_rate":f"{rate:.2f}","tax_amount":f"{tax:.2f}","total":f"{amount+tax:.2f}"}\n\nif __name__ == "__main__":\n    json.dump(calculate_acceptance_total(**json.load(sys.stdin)),sys.stdout)\n';
const serviceSource='# /// script\n# requires-python = ">=3.11"\n# dependencies = ["mcp", "uvicorn"]\n# ///\nimport json\nimport os\n\nfrom mcp.server.lowlevel import Server\nfrom mcp.types import CallToolRequestParams, CallToolResult, ListToolsResult, TextContent, Tool\n\nTOOL_NAME = "get_acceptance_order"\nINPUT_SCHEMA = {"type": "object", "properties": {"order_id": {"type": "string"}}, "required": ["order_id"]}\nORDERS = {"ORDER-001": {"order_id": "ORDER-001", "currency": "CNY", "subtotal": "100.00", "tax_rate": "0.06", "approved": True}}\n\n\ndef execute(name, arguments):\n    return ORDERS.get(arguments.get("order_id")) or {"status": "unavailable"}\n\n\nasync def _list_tools(_context, _params) -> ListToolsResult:\n    return ListToolsResult(tools=[Tool(name=TOOL_NAME, description="Return a fixed order", inputSchema=INPUT_SCHEMA)])\n\n\nasync def _call_tool(_context, params: CallToolRequestParams) -> CallToolResult:\n    output = execute(params.name, dict(params.arguments or {}))\n    return CallToolResult(content=[TextContent(type="text", text=json.dumps(output, ensure_ascii=False))])\n\n\nserver = Server(name="acceptance-orders-mcp", version="0.1.0", on_list_tools=_list_tools, on_call_tool=_call_tool)\n\n\ndef main() -> None:\n    import uvicorn\n    port = int(os.environ.get("PORT", "8080"))\n    uvicorn.run(server.streamable_http_app(streamable_http_path="/mcp"), host="0.0.0.0", port=port)\n\n\nif __name__ == "__main__":\n    main()\n';

/** What A4 delivers. The platform places these files; it does not write them. */
const implementationFixture=async input=>{
  const idByName=Object.fromEntries(input.tools.map(tool=>[tool.name,tool.toolId]));
  const byTool={
    calculate_acceptance_total:{toolId:idByName.calculate_acceptance_total,status:'PRODUCED',language:'python',
      entrypoint:'scripts/calculate_acceptance_total.py',files:['scripts/calculate_acceptance_total.py'],
      start:['uv','run','--no-project','scripts/calculate_acceptance_total.py'],
      changes:[],drift:[],compilePassed:true,contractPassed:true},
    get_acceptance_order:{toolId:idByName.get_acceptance_order,status:'PRODUCED',language:'python',
      entrypoint:'mcp-python/server.py',files:['mcp-python/server.py'],
      // Started by the platform, so it has to be a command that really works.
      start:['uv','run','--no-project','mcp-python/server.py'],
      // A real adaptation, reported rather than hidden: the runtime wrapper is gone, so the Tool is
      // reached over MCP instead of being registered into the host process.
      changes:[{path:'order_id',change:'调用方式由 runtime 注册改为 MCP tools/call',reason:'旧 runtime 不可用，接口参数本身未变'}],
      drift:[{where:'inputSchema',baseline:{required:['order_id']},observed:{required:['order_id']}}],
      compilePassed:true,contractPassed:true},
  };
  return {status:'PRODUCED',
    payload:{status:'PRODUCED',tools:Object.values(byTool),skillDelivery:{skillFile:'SKILL.md',files:[{source:'migration-skill/SKILL.md',path:'SKILL.md'},{source:'migration-skill/policy.md',path:'references/acceptance-policy.md'}]}},
    files:{'migration-skill/SKILL.md':(await readFile(path.join(root,'acceptance/openjiuwen-portability/legacy-skill/SKILL.md'))).toString('base64'),
      'migration-skill/policy.md':(await readFile(path.join(root,'acceptance/openjiuwen-portability/legacy-skill/references/acceptance-policy.md'))).toString('base64'),
      'scripts/calculate_acceptance_total.py':Buffer.from(scriptSource).toString('base64'),
      'mcp-python/server.py':Buffer.from(serviceSource).toString('base64')}};
};

/**
 * Stubbed by default, real on request.
 *
 * The stubs are what makes this runnable in CI: they take the model out of the loop so the check is
 * about the platform's own code. `MIGRATION_TEST_REAL_AGENTS=true` takes them out and lets the page
 * drive the real agents instead -- the one combination neither this script (stubs) nor
 * verify-real-agent-migration.mjs (HTTP, no page) covers. It needs a model, so: not in CI.
 */
const realAgents=process.env.MIGRATION_TEST_REAL_AGENTS==='true';
// An agent run is minutes, and the browser is waiting on it.
const STEP=realAgents?900_000:30_000;
const stubs=realAgents?{}:{migrationAnalyzer,migrationImplementer:implementationFixture,
  // The question writer is the platform's, so it is stood in here: what this script checks is that
  // the analysis reaches it and that the result is reachable from the page.
  migrationSuite:async input=>({summary:`从分析生成：${input.tools.join('、')}`,
    cases:[{caseId:'suite-order-1',prompt:'查询订单 ORDER-001 的金额与审批状态',requiredTools:[input.tools[0]],taskMode:'single_turn',rubric:[{criterionId:'order-facts',label:'订单事实',dimension:'business_completeness',description:'返回订单金额与审批状态',weight:1,allOf:[],anyOf:[],noneOf:[]}]}]})};
const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,
  publicDirectory:path.resolve(process.env.MIGRATION_TEST_WEB_DIR||path.join(root,'web-dist')),
  accessToken:token,publicDemo:false,...stubs});
pass(realAgents?'agent_mode=REAL':'agent_mode=STUBBED');
let browser,proxy,page=null,failedAt=null;
try{
  let serviceUrl=await app.listen({host:'127.0.0.1',port:0});
  // The private deployment is served under a subpath behind an SSO gateway that owns the
  // Authorization header. Driving that shape needs a proxy in front, and it is the shape that
  // ships -- the plain root path is the exception.
  const prefix=process.env.MIGRATION_TEST_PREFIX;
  if(prefix){
    assert(/^\/[a-z-]+\/$/u.test(prefix));
    const target=serviceUrl;
    proxy=http.createServer((req,res)=>{
      if(!req.url.startsWith(prefix)){res.statusCode=404;res.end();return;}
      const forwarded={...req.headers};
      if(process.env.MIGRATION_TEST_PRIVATE_GATEWAY==='true'){
        forwarded.authorization=String(req.headers['x-migration-authorization']||'');
        delete forwarded['x-migration-authorization'];
      }
      const upstream=http.request(new URL(req.url.slice(prefix.length-1),target),{method:req.method,headers:forwarded},response=>{
        res.writeHead(response.statusCode,response.headers);response.pipe(res);
      });
      upstream.on('error',()=>{res.statusCode=502;res.end();});req.pipe(upstream);
    });
    await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
    serviceUrl=`http://127.0.0.1:${proxy.address().port}${prefix}`;
  }
  const headers={authorization:`Bearer ${token}`,'content-type':'application/zip'};
  const legacyZip=await migrationArchive(path.join(root,'acceptance/openjiuwen-portability/legacy-skill'));
  const credentialPattern=/(?:api[_-]?key|password|secret|token)\s*[:=]\s*["'][^"'\n]{8,}["']/i;
  for(const [name,content] of Object.entries(unzipSync(legacyZip))){
    const match=Buffer.from(content).toString().match(credentialPattern);
    if(match)throw new Error(`Acceptance fixture triggers credential scan in ${name}: ${match[0].slice(0,40)}`);
  }

  browser=await chromium.launch({...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{}),headless:true});
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});
  page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(serviceUrl);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
  await page.getByRole('button',{name:'新建迁移',exact:true}).click();
  await page.locator('input[type=file]').first().setInputFiles({name:'legacy-skill.zip',mimeType:'application/zip',buffer:legacyZip});
  await page.getByRole('heading',{name:'迁移改造方案',exact:true}).waitFor({timeout:STEP});
  if(realAgents){
    // What A2 reports is A2's judgement, and a real one is entitled to disagree with the stub's.
    // What the page owes is that the Tools it found are on it.
    // The heading is on screen before the inspection finishes -- it appears when the stage renders.
    // With the agents stubbed that is invisible; with the real ones it is two minutes of waiting.
    for(const name of ['get_acceptance_order','calculate_acceptance_total'])
      await expect(page.getByText(name,{exact:false}).first()).toBeVisible({timeout:STEP});
  }else{
    await expect(page.locator('.diagnosis-tool')).toHaveCount(2);
  }
  pass('legacy_skill_uploaded_and_inspected');

  await page.locator('article').filter({hasText:'calculate_acceptance_total'}).getByLabel('转换形式').selectOption('SCRIPT');
  await page.locator('article').filter({hasText:'get_acceptance_order'}).getByLabel('转换形式').selectOption('MCP');
  await page.getByRole('button',{name:'确认方案，进入生成',exact:true}).click();
  await page.getByRole('button',{name:'开始生成',exact:true}).click();
  await expect(page.getByText('迁移代码已生成。',{exact:true})).toHaveCount(2,{timeout:STEP});
  await expect(page.getByText('已生成工具工程，请先完成代码中的待办。',{exact:true})).toHaveCount(0);
  pass('mixed_choices_generated_with_business_code');

  // The interface-change report is carried to the UI. It is a report: both Tools passed regardless.
  if(!realAgents){
    const mcpCardReport=page.locator('article').filter({hasText:'get_acceptance_order'});
    await mcpCardReport.getByText('查看生成说明和接口改动',{exact:true}).click();
    await expect(mcpCardReport.getByText('旧 runtime 不可用，接口参数本身未变',{exact:false})).toBeVisible();
    await expect(mcpCardReport.getByText('基线 ',{exact:false})).toBeVisible();
    pass('interface_change_report_visible');
  }

  await page.locator('.stage-actions').getByRole('button',{name:'Runtime 适配与登记',exact:true}).click();
  await page.locator('.stage-actions').getByRole('button',{name:'验证能否运行',exact:true}).click();
  const scriptCard=page.locator('article').filter({hasText:'calculate_acceptance_total'});
  await scriptCard.getByText('高级设置：覆盖自动测试参数',{exact:true}).click();
  await scriptCard.locator('textarea').fill('{"subtotal":"100.00","tax_rate":"0.06"}');
  await scriptCard.getByRole('button',{name:'开始试运行',exact:true}).click();
  await expect(scriptCard.getByText('验证通过',{exact:true})).toBeVisible({timeout:STEP});
  const mcpCard=page.locator('article').filter({hasText:'get_acceptance_order'});
  // Nothing to type: the platform starts the delivered service itself, and the page says so.
  await expect(mcpCard.getByText('试运行时会自动启动生成的 MCP 服务。',{exact:false})).toBeVisible();
  await expect(mcpCard.getByLabel('共享 MCP 服务地址')).toHaveCount(0);
  await mcpCard.getByText('高级设置：覆盖自动测试参数',{exact:true}).click();
  await mcpCard.locator('textarea').fill('{"order_id":"ORDER-001"}');
  await mcpCard.getByRole('button',{name:'开始试运行',exact:true}).click();
  await expect(mcpCard.getByText('验证通过',{exact:true})).toBeVisible({timeout:STEP});
  pass('script_and_mcp_technical_validation');

  // The test set is written from the analysis, and a reader has to be able to reach it: generated
  // here, listed with its questions, and offered as the content for the whole-Skill validation.
  await page.locator('.stage-actions').getByRole('button',{name:'验证实际效果',exact:true}).click();
  await page.getByRole('button',{name:/提供测试集和目标/}).click();
  await page.getByLabel('准备方式').selectOption('ai');
  await page.getByRole('button',{name:'AI 生成',exact:true}).click();
  await expect(page.locator('.assessment-config-grid select').first().locator('option')).toHaveCount(2,{timeout:STEP});
  await page.getByText(/查看 \d+ 条用例与验收要求/).click();
  if(!realAgents){
    await expect(page.locator('.assessment-config-grid select').first().locator('option').last()).toContainText('从分析生成：get_acceptance_order、calculate_acceptance_total');
    await expect(page.getByText('查询订单 ORDER-001 的金额与审批状态',{exact:true})).toBeVisible();
  }
  pass('generated_test_set_visible_and_selectable');

  await page.getByRole('button',{name:'进入下载',exact:true}).click();
  await expect(page.getByText('迁移包将标记为未验证',{exact:true})).toBeVisible();
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'下载迁移包',exact:true}).click();
  const download=await pending,target=path.join(downloads,'migration.zip');await download.saveAs(target);
  assert(download.suggestedFilename().endsWith('-unverified.zip'));
  const exported=unzipSync(await readFile(target));
  // The Skill keeps its layout; the Script goes where the Skill layout says; the MCP service keeps
  // the paths the agent reported, because the platform did not build it.
  assert(exported['skill/SKILL.md']);
  assert(Buffer.from(exported['skill/SKILL.md']).toString('utf8').includes('If the order is unavailable or unapproved, stop'));
  assert(exported['skill/references/acceptance-policy.md']);
  assert(!exported['migration-manifest.json']);assert(!exported['migration-report.json']);
  if(realAgents){
    // The agent named the paths; what the platform owes is that a Script landed under scripts/ and
    // a service somewhere of the agent's choosing, with the runtime-coupled original gone.
    assert(Object.keys(exported).some(name=>name.startsWith('skill/scripts/')&&name.endsWith('.py')));
    assert(Object.keys(exported).some(name=>!name.startsWith('skill/')&&name.endsWith('.py')));
  }else{
    assert(exported['skill/scripts/calculate_acceptance_total.py']);
    assert(exported['mcp-python/server.py']);
    const script=Buffer.from(exported['skill/scripts/calculate_acceptance_total.py']).toString();
    assert.match(script,/Decimal\(subtotal\)/);assert.doesNotMatch(script,/agentscope\.tool/);
  }
  // The runtime-coupled original is replaced, never shipped alongside its migration.
  assert(!Object.keys(exported).some(name=>name.includes('legacy_runtime_tools')));
  await page.getByRole('status').filter({hasText:'下载已开始'}).waitFor();
  pass('unverified_candidate_downloaded_with_source_workflow');
  assert.deepEqual(errors,[]);pass('no_browser_errors');
  await page.setViewportSize({width:390,height:900});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));pass('mobile_no_overflow');
  process.stdout.write(`${JSON.stringify({mode:'REAL_SERVICE_HEADLESS_CHROME',checks},null,2)}\n`);
}catch(error){failedAt=error;throw error;}finally{
  // A browser check that fails in CI without a picture is a check nobody can act on.
  if(browser&&failedAt){
    const shot=await page?.screenshot().catch(()=>null);
    if(shot){await mkdir(path.resolve('reports/migration-v2-ui'),{recursive:true}).catch(()=>undefined);
      await writeFile(path.resolve('reports/migration-v2-ui/failure.png'),shot).catch(()=>undefined);}
  }
  if(browser)await browser.close();
  if(proxy){proxy.closeAllConnections();await close(proxy);}
  await app.close();await Promise.all([rm(data,{recursive:true,force:true}),rm(downloads,{recursive:true,force:true})]);
}
