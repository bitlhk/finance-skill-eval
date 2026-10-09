import {approveMigrationPlanThroughUi} from './lib/verify-reuse-plan-ui.mjs';
import {reusePlanFixture} from './lib/reuse-plan-fixture.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect } from '@playwright/test';
import { unzipSync, zipSync } from 'fflate';
import { createEvaluationService } from '../dist/service/server.js';
import {writeAcceptanceResult} from './lib/migration-acceptance-results.mjs';

/**
 * Drive the migration UI in a real browser against a real service.
 *
 * Default mode uses agent, execution Runtime and Judge fixtures for deterministic UI regression.
 * MIGRATION_TEST_REAL_AGENTS=true calls real analysis, migration, suite and Judge models, but
 * retains a fixture execution Runtime. That mode checks model integration and UI rendering; it
 * must never claim migrated business behavior or Builder Launcher acceptance.
 * Add MIGRATION_TEST_LAUNCHER_INFO=<private connection-info.json> to exercise a real Builder
 * Launcher as well. This mode requires real agents/Judge and asserts every business case passes.
 */
const root=process.cwd();
const resumeData=process.env.MIGRATION_TEST_RESUME_DATA;
const data=resumeData?path.resolve(resumeData):await mkdtemp(path.join(os.tmpdir(),'migration-v2-ui-'));
const downloads=await mkdtemp(path.join(os.tmpdir(),'migration-v2-download-'));
const token='migration-v2-ui-test';
// This test owns every executable it uploads and runs it in an isolated temporary workspace.
// Keep the production default locked down; opt in only for this trusted end-to-end process.
process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS='1';
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
let observeGenerationStages=false,releaseGenerationStage;
const holdGenerationStage=()=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('UI did not observe the running generation stage')),30000);
  releaseGenerationStage=()=>{clearTimeout(timer);resolve();};
});
const migrationAnalyzer=async input=>{
  const payload=structuredClone(analysis);
  if(input.runId.endsWith('-verify')){
    if(observeGenerationStages)await holdGenerationStage();
    for(const tool of payload.tools){
      const script=tool.name==='calculate_acceptance_total';
      const path=Object.keys(input.files).find(path=>script?path.endsWith('/calculate_acceptance_total.py'):path.endsWith('/server.py'));
      tool.sourcePaths=[path];tool.portability=script?'PORTABLE_SCRIPT':'PORTABLE_MCP';
      if(script)tool.entrypoint={kind:'PYTHON',path};
    }
  }
  return {status:'PRODUCED',payload,scanner};
};

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
const launcherInfoPath=process.env.MIGRATION_TEST_LAUNCHER_INFO;
assert(!launcherInfoPath||realAgents,'External Launcher acceptance requires real agents and Judge');
assert(!resumeData||(realAgents&&launcherInfoPath),'Resume requires retained real-agent data and a real Launcher');
const launcherInfo=launcherInfoPath?JSON.parse(await readFile(launcherInfoPath,'utf8')):null;
if(launcherInfo){
  assert.equal(launcherInfo.status,'READY','Builder Launcher is not ready');
  assert.equal(typeof launcherInfo.baseUrl,'string');assert.equal(typeof launcherInfo.token,'string');
  process.env.MIGRATION_UI_LAUNCHER_CREDENTIAL=launcherInfo.token;
}
// An agent run is minutes, and the browser is waiting on it.
const STEP=realAgents?900_000:30_000;
const stubs=realAgents?{}:{migrationAnalyzer,migrationImplementer:implementationFixture,migrationReusePlanner:async input=>{
  if(observeGenerationStages&&input.mode==='REVIEW')await holdGenerationStage();
  return reusePlanFixture(input);
},
  migrationImprovementPlanner:async input=>({status:'PROPOSED',hypothesis:{layer:'TOOL',issue:'需要检查订单工具的结果映射',
    expectedBehavior:'工具返回的订单状态和金额进入最终回答',evidenceCaseIds:[input.cases[0].caseId],
    validation:'先验证工具返回，再用同一开发题复测',risk:'可能改变已有字段映射',confidence:'MEDIUM',
    toolIds:[input.tools.find(tool=>tool.name==='calculate_acceptance_total').toolId]}}),
  migrationToolOptimizationProposer:async input=>{
    const file=Object.keys(input.files).find(path=>path.endsWith('calculate_acceptance_total.py'));
    const source=file&&input.files[file];
    assert.ok(source,`Tool 文件：${Object.keys(input.files).join(', ')}`);
    assert.ok(!JSON.stringify(input).includes('独立订单复核情境'));
    return {toolId:input.toolIds[0],summary:'修正计算工具的边界处理',changes:[{path:file,
      content:`${source}\n# Tool optimization experiment\n`,reason:'保留业务算法，验证独立 Tool 候选流程'}]};
  },
  // The question writer is the platform's, so it is stood in here: what this script checks is that
  // the analysis reaches it and that the result is reachable from the page.
  migrationSuite:async input=>({summary:`从分析生成：${input.tools.join('、')}`,
    cases:[{caseId:'suite-order-1',prompt:'查询订单 ORDER-001 的金额与审批状态',requiredTools:[input.tools[0]],taskMode:'single_turn',rubric:[{criterionId:'order-facts',label:'订单事实',dimension:'business_completeness',description:'返回订单金额与审批状态',weight:1,allOf:[],anyOf:[],noneOf:[]}]}]})};

const instances=new Map();
let blockJudge=false,blockedJudgeRequests=0;
const fixtureServer=http.createServer((request,response)=>{void (async()=>{
  const url=new URL(request.url??'/',`http://${request.headers.host}`);
  const json=value=>{response.statusCode=200;response.setHeader('content-type','application/json');response.end(JSON.stringify(value));};
  const body=async()=>{const chunks=[];for await(const chunk of request)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}');};
  if(request.method==='GET'&&url.pathname==='/v1/runtime-capabilities')return json({schemaVersion:'finance.skill-eval.runtime-capabilities.v1',runtime:{type:'openjiuwen',version:'e2e-fixture'},models:[{modelId:'fixture-execution',upstreamModelId:'fixture-execution',label:'E2E 执行模型'}],defaultModelId:'fixture-execution',features:{streaming:false,asyncLaunch:false,packagedMcp:true,externalMcp:true,inlineSecrets:true},limits:{maxArchiveBytes:8_000_000,maxFiles:500,maxTimeoutMs:310_000,maxConcurrentInstances:4}});
  if(request.method==='POST'&&url.pathname==='/v1/runtime-instances'){
    const input=await body(),instanceId=`fixture-${instances.size+1}`,configurationDigest=`fixture-configuration-${instances.size+1}`;
    if(input.generation)assert.deepEqual(input.generation,{schemaVersion:'finance.eval-generation.v1',temperature:0,top_p:1,max_tokens:2048});
    instances.set(instanceId,{input,configurationDigest});
    return json({schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId,status:'ready',executeEndpoint:`/v1/runtime-instances/${instanceId}/execute`,expiresAt:new Date(Date.now()+300_000).toISOString(),error:null,configurationDigest});
  }
  const execute=url.pathname.match(/^\/v1\/runtime-instances\/([^/]+)\/execute$/u);
  if(request.method==='POST'&&execute){
    const stored=instances.get(execute[1]),input=await body();if(!stored){response.statusCode=404;return response.end();}
    const skill=stored.input.skill;
    return json({runId:stored.input.runId,side:stored.input.side,caseId:input.caseId,status:'completed',modelId:stored.input.modelId,skillVersion:skill?.version??null,
      output:'订单 ORDER-001：币种 CNY，小计 100.00，税率 0.06，已审批。',elapsedMs:5,toolCalls:(input.requiredTools??[]).map(name=>({name,status:'completed'})),
      loadedSkills:skill?[{skillId:skill.skillId,version:skill.version}]:[],usage:null,runtimeIdentityVerified:true,streamCompleted:true,error:null,
      metadata:{skillArtifactSha256:skill?.artifactSha256,instanceConfigurationDigest:stored.configurationDigest,workspaceFilesDigest:null,
        ...(stored.input.generation?{declaredModelParameters:{temperature:stored.input.generation.temperature,top_p:stored.input.generation.top_p,max_tokens:stored.input.generation.max_tokens},modelGenerationHostVerified:true,modelParametersBasis:'CONTROLLED_FIXTURE_NOT_MODEL_WIRE'}:{}),
        toolEvidence:(input.requiredTools??[]).map(tool=>({tool,resultDigest:'a'.repeat(64)}))}});
  }
  const instance=url.pathname.match(/^\/v1\/runtime-instances\/([^/]+)$/u);
  if(request.method==='DELETE'&&instance){instances.delete(instance[1]);response.statusCode=204;return response.end();}
  if(request.method==='POST'&&url.pathname==='/v1/chat/completions'){
    const requestBody=await body();const userMessage=requestBody.messages?.findLast(message=>message.role==='user');
    if(blockJudge){blockedJudgeRequests++;return;}
    let contract;try{contract=JSON.parse(userMessage?.content??'{}').responseContract}catch{contract=null}
    const judged=contract?.dimensions?{winner:'TIE',confidence:'high',summary:'两个方案在测试用例上表现相当。',dimensions:contract.dimensions.map(dimension=>({id:dimension.id,aScore:3,bScore:3,reason:'两侧均完成任务。'}))}
      :{checks:[{criterionIndex:0,verdict:'PASS',reason:'回答包含订单金额和审批状态。',evidence:'小计 100.00，税率 0.06，已审批'}]};
    return json({model:'fixture-judge',choices:[{message:{content:JSON.stringify(judged)}}],usage:{prompt_tokens:10,completion_tokens:10,total_tokens:20}});
  }
  response.statusCode=404;response.end();
})().catch(error=>{response.statusCode=500;response.end(String(error));});});
await new Promise(resolve=>fixtureServer.listen(0,'127.0.0.1',resolve));
const fixtureBase=`http://127.0.0.1:${fixtureServer.address().port}`;
if(!realAgents){
  process.env.FINANCE_EVAL_JUDGE_BASE_URL=`${fixtureBase}/v1`;
  process.env.FINANCE_EVAL_JUDGE_API_KEY='e2e-fixture-key';
  process.env.FINANCE_EVAL_JUDGE_MODEL='fixture-judge';
  // The controller checks this role even when an already-passing baseline needs no edit.
  process.env.FINANCE_EVAL_OPTIMIZER_PROVIDER='openai_compatible';
  process.env.FINANCE_EVAL_OPTIMIZER_BASE_URL=`${fixtureBase}/v1`;
  process.env.FINANCE_EVAL_OPTIMIZER_API_KEY='e2e-fixture-key';
  process.env.FINANCE_EVAL_OPTIMIZER_MODEL='fixture-optimizer';
}
const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,
  publicDirectory:path.resolve(process.env.MIGRATION_TEST_WEB_DIR||path.join(root,'web-dist')),
  accessToken:token,publicDemo:false,...stubs});
app.log.level='error';
const runtimeRegistration={type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:launcherInfo?.baseUrl??`${fixtureBase}/`,
  ...(launcherInfo?{credentialEnv:'MIGRATION_UI_LAUNCHER_CREDENTIAL'}:{})};
if(!resumeData){
  const environmentResponse=await app.inject({method:'POST',url:'/api/environments',headers:{authorization:`Bearer ${token}`},payload:{name:'E2E Runtime',...runtimeRegistration}});
  assert.equal(environmentResponse.statusCode,200,environmentResponse.body);
  const previousEnvironmentResponse=await app.inject({method:'POST',url:'/api/environments',headers:{authorization:`Bearer ${token}`},payload:{name:'E2E Previous Runtime',...runtimeRegistration}});
  assert.equal(previousEnvironmentResponse.statusCode,200,previousEnvironmentResponse.body);
}else{
  // Retained runs freeze old endpoints. Rebind only this test's two named
  // registrations to the newly supplied live Launcher; do not rewrite history.
  const catalog=await app.inject({method:'GET',url:'/api/catalog',headers:{authorization:`Bearer ${token}`}});
  assert.equal(catalog.statusCode,200);
  const environments=catalog.json().environments;
  for(const name of ['E2E Runtime','E2E Previous Runtime']){
    const matches=environments.filter(item=>item.name===name&&item.type==='runtime_launcher');
    assert.equal(matches.length,1,`Retained test registration not unique: ${name}`);
    const response=await app.inject({method:'PUT',url:`/api/environments/${matches[0].environmentId}`,
      headers:{authorization:`Bearer ${token}`},payload:{name,...runtimeRegistration}});
    assert.equal(response.statusCode,200,response.body);
  }
}
pass(realAgents?'agent_mode=REAL':'agent_mode=STUBBED');
let browser,proxy,page=null,failedAt=null;
let acceptedCases=[];
let verifyCancellation;
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
  if(resumeData){
    await expect(page.getByRole('button',{name:'继续处理',exact:true})).toHaveCount(1);
    await page.getByRole('button',{name:'继续处理',exact:true}).click();
    await page.getByRole('navigation',{name:'迁移步骤'}).getByRole('button',{name:/验证实际效果/}).click();
    pass('resumed_real_model_generated_candidate_and_frozen_suite');
  }else{
  await page.getByRole('button',{name:'新建迁移',exact:true}).click();
  await page.locator('input[type=file]').first().setInputFiles({name:'legacy-skill.zip',mimeType:'application/zip',buffer:legacyZip});
  await page.getByRole('heading',{name:'诊断与工具选择',exact:true}).waitFor({timeout:STEP});
  if(realAgents){
    // What A2 reports is A2's judgement, and a real one is entitled to disagree with the stub's.
    // What the page owes is that the Tools it found are on it.
    // The heading is on screen before the inspection finishes -- it appears when the stage renders.
    // With the agents stubbed that is invisible; with the real ones it is two minutes of waiting.
    for(const name of ['get_acceptance_order','calculate_acceptance_total'])
      await expect(page.getByText(name,{exact:false}).first()).toBeVisible({timeout:STEP});
  }else{
    await expect(page.locator('.diagnosis-tool')).toHaveCount(2,{timeout:STEP});
  }
  pass('legacy_skill_uploaded_and_inspected');

  await page.locator('article.diagnosis-tool').filter({has:page.getByRole('heading',{name:/^\d+\. calculate_acceptance_total$/})}).getByLabel('转换形式').selectOption('SCRIPT');
  await page.locator('article.diagnosis-tool').filter({has:page.getByRole('heading',{name:/^\d+\. get_acceptance_order$/})}).getByLabel('转换形式').selectOption('MCP');
  await approveMigrationPlanThroughUi(page);
await page.getByRole('button',{name:'确认方案，进入生成',exact:true}).click();
  const generationResponse=page.waitForResponse(response=>response.url().endsWith('/generate')&&response.request().method()==='POST',{timeout:STEP});
  observeGenerationStages=!realAgents;
  await page.getByRole('button',{name:'开始生成',exact:true}).click();
  if(!realAgents){
    await expect(page.getByRole('heading',{name:'分析候选能力与依赖',exact:true})).toBeVisible({timeout:STEP});
    releaseGenerationStage();
    await expect(page.getByRole('heading',{name:'审查迁移方案落实情况',exact:true})).toBeVisible({timeout:STEP});
    releaseGenerationStage();observeGenerationStages=false;
    pass('ui_generation_analysis_and_review_progress_visible');
  }
  const generation=await generationResponse;
  assert.equal(generation.status(),200,`迁移生成失败：HTTP ${generation.status()} ${(await generation.text()).slice(0,500)}`);
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
  await expect(page.getByLabel('Builder Result JSON')).toBeVisible();
  for(const target of ['agentscope','openjiuwen']){
    await page.getByLabel('交付目标',{exact:true}).selectOption(target);
    await expect(page.getByLabel('交付目标',{exact:true})).toHaveValue(target);
    await expect(page.getByRole('button',{name:'下载能力需求 YAML',exact:true})).toBeDisabled();
  }
  // No Harness gap means no Builder requirement to download. A second explicit
  // delivery may still be imported; the server checks its contract independently.
  pass('runtime_import_remains_visible_without_inventing_builder_requirements');
  await page.locator('.stage-actions').getByRole('button',{name:'验证能否运行',exact:true}).click();
  const scriptCard=page.locator('article').filter({hasText:'calculate_acceptance_total'});
  await scriptCard.getByText('高级设置：覆盖自动测试参数',{exact:true}).click();
  await scriptCard.locator('textarea').fill('{"subtotal":"100.00","tax_rate":"0.06"}');
  const scriptValidationResponse=page.waitForResponse(response=>response.url().endsWith('/validate/technical')&&response.request().method()==='POST');
  await scriptCard.getByRole('button',{name:'开始试运行',exact:true}).click();
  const scriptValidation=await (await scriptValidationResponse).json();
  assert.equal(scriptValidation.status,'PASSED',JSON.stringify(scriptValidation));
  await expect(scriptCard.getByText('验证通过',{exact:true})).toBeVisible({timeout:STEP});
  const mcpCard=page.locator('article').filter({hasText:'get_acceptance_order'});
  // Nothing to type: the platform starts the delivered service itself, and the page says so.
  await expect(mcpCard.getByText('试运行时会自动启动生成的 MCP 服务。',{exact:false})).toBeVisible();
  await expect(mcpCard.getByLabel('共享 MCP 服务地址')).toHaveCount(0);
  await mcpCard.getByText('高级设置：覆盖自动测试参数',{exact:true}).click();
  await mcpCard.locator('textarea').fill('{"order_id":"ORDER-001"}');
  const mcpValidationResponse=page.waitForResponse(response=>response.url().endsWith('/validate/technical')&&response.request().method()==='POST');
  await mcpCard.getByRole('button',{name:'开始试运行',exact:true}).click();
  const mcpValidation=await (await mcpValidationResponse).json();
  assert.equal(mcpValidation.status,'PASSED',JSON.stringify(mcpValidation));
  await expect(mcpCard.getByText('验证通过',{exact:true})).toBeVisible({timeout:STEP});
  pass('script_and_mcp_technical_validation');

  // The test set is written from the analysis, and a reader has to be able to reach it: generated
  // here, listed with its questions, and offered as the content for the whole-Skill validation.
  await page.locator('.stage-actions').getByRole('button',{name:'验证实际效果',exact:true}).click();
  }
  await page.getByRole('button',{name:/提供测试集和目标/}).click();
  if(!resumeData){
  await page.getByLabel('准备方式').selectOption('ai');
  await page.getByRole('button',{name:'AI 生成',exact:true}).click();
  }
  await expect(page.locator('.assessment-config-grid select').first().locator('option')).toHaveCount(2,{timeout:STEP});
  if(resumeData)await page.locator('.assessment-config-grid select').first().selectOption({index:1});
  await page.getByText(/查看 \d+ 条用例与验收要求/).click();
  if(!realAgents){
    await expect(page.locator('.assessment-config-grid select').first().locator('option').last()).toContainText('从分析生成：get_acceptance_order、calculate_acceptance_total');
    await expect(page.getByText('查询订单 ORDER-001 的金额与审批状态',{exact:true})).toBeVisible();
  }
  pass('generated_test_set_visible_and_selectable');

  await page.locator('.assessment-config-grid select').nth(1).selectOption({label:'E2E Runtime'});
  const previousResultCount=await page.locator('.assessment-results .migration-result').count();
  const startedEvaluation=page.waitForResponse(response=>response.url().endsWith('/validate/openjiuwen')&&response.request().method()==='POST',{timeout:STEP});
  await page.getByRole('button',{name:'执行并自动评估',exact:true}).click();
  const evaluationResponse=await startedEvaluation;
  assert.equal(evaluationResponse.status(),200,'UI failed to start an evaluation');
  const evaluationJobId=(await evaluationResponse.json()).job.jobId;
  await expect(page.locator('.assessment-results .migration-result')).toHaveCount(previousResultCount+1,{timeout:STEP});
  if(realAgents){
    const terminal=page.locator('.assessment-results .migration-result').first().locator(':scope > summary .stage-badge');
    await expect(terminal).toContainText(/已完成|失败|中断|取消/,{timeout:STEP});
    await expect(terminal).toContainText('已完成');
    const evaluated=await app.inject({method:'GET',url:`/api/runs/${evaluationJobId}`,headers:{authorization:`Bearer ${token}`}});
    assert.equal(evaluated.statusCode,200);
    acceptedCases=evaluated.json().report.cases.map(c=>({caseId:c.caseId,verdict:c.judge?.goalAssessment?.verdict??'UNKNOWN'}));
    const caseBadges=await page.locator('.assessment-results .migration-result').first().locator('.assessment-case > summary .stage-badge').allTextContents();
    assert(caseBadges.length>0,'真实模型生成的测试集没有产生用例结果');
    if(launcherInfo){
      assert(caseBadges.every(badge=>badge.trim()==='通过'),`Builder 真实执行未全部通过：${caseBadges.join(', ')}`);
      pass(`real_builder_and_real_judge:${caseBadges.length}_cases_passed`);
    }else{
      pass(`real_judge_on_fixture_runtime:${caseBadges.length}_cases`);
      pass('fixture_runtime_is_not_migration_acceptance');
    }
    process.stdout.write(`${JSON.stringify({mode:launcherInfo?'REAL_AGENTS_JUDGE_AND_BUILDER':'REAL_AGENTS_AND_JUDGE_WITH_FIXTURE_RUNTIME',checks,caseBadges},null,2)}\n`);
  }else{
  await expect(page.getByText('最新 1/1 通过',{exact:true})).toBeVisible({timeout:STEP});
  const assessedCase=page.locator('.assessment-case').filter({hasText:'suite-order-1'});
  await assessedCase.locator(':scope > summary').click();
  await assessedCase.getByText('迁移后回答',{exact:true}).click();
  await expect(assessedCase.getByText('订单 ORDER-001：币种 CNY，小计 100.00，税率 0.06，已审批。',{exact:true})).toBeVisible();
  pass('candidate_effect_assessment_passed');

  if(!realAgents){
    await page.getByRole('button',{name:'分析当前结果',exact:true}).click();
    await expect(page.getByText('需要检查订单工具的结果映射',{exact:true})).toBeVisible({timeout:STEP});
    pass('evidence_grounded_improvement_plan_visible');
    await page.getByLabel('准备方式').selectOption('import');
    await page.getByLabel('预览或编辑测试集').fill(JSON.stringify({name:'含留出题的复核集',cases:[{id:'dev-order',input:'查询订单 ORDER-001',criteria:['返回订单金额和状态']}],
      holdoutCases:[{id:'sealed-order',input:'独立订单复核情境',criteria:['返回正确的订单结论']}]}));
    const importedResponse=page.waitForResponse(response=>response.url().endsWith('/suites/import')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'确认并导入',exact:true}).click();
    const imported=await (await importedResponse).json();
    assert.deepEqual(imported.holdoutCases.map(item=>item.caseId),['sealed-order']);
    pass('ui_imported_frozen_holdout_set');
  }

  await page.getByRole('button',{name:/对比旧版与新版 Runtime/}).click();
  await page.getByLabel('旧版 Runtime').selectOption({label:'E2E Previous Runtime'});
  await page.getByLabel('旧版执行模型').selectOption('fixture-execution');
  await page.getByRole('button',{name:'对比两套方案',exact:true}).click();
  await expect(page.getByText('整套方案对比',{exact:true}).first()).toBeVisible({timeout:STEP});
  await expect(page.getByText('最新 0/1 新版胜出',{exact:true})).toBeVisible({timeout:STEP});
  await expect(page.getByText('两侧 Launcher 或模型可能不同；此结果不能单独归因于 Skill 文档。',{exact:true})).toBeVisible({timeout:STEP});
  if(!realAgents){
    const toolAttemptResponse=page.waitForResponse(response=>response.url().endsWith('/tool-optimizations')&&response.request().method()==='POST');
    await page.getByRole('button',{name:'生成并技术验证',exact:true}).click();
    const toolAttempt=await (await toolAttemptResponse).json();
    assert.equal(toolAttempt.status,'TECHNICAL_PASSED',JSON.stringify(toolAttempt));
    await expect(page.getByText('技术验证通过，待采用',{exact:true})).toBeVisible({timeout:STEP});
    await page.getByRole('button',{name:'采用此候选，随后重新评测',exact:true}).click();
    await expect(page.getByText('当前改进动作：')).toHaveCount(0);
    pass('ui_tool_candidate_isolated_validated_and_adopted');
    await page.getByRole('button',{name:/提供测试集和目标/}).click();
    await page.getByRole('button',{name:'执行并自动评估',exact:true}).click();
    await expect(page.getByText('最新 1/1 通过',{exact:true})).toBeVisible({timeout:STEP});
    pass('ui_tool_candidate_effect_reevaluated');
  }
  pass('whole_solution_comparison_visible');
  verifyCancellation=async()=>{
  await page.getByRole('navigation',{name:'迁移步骤'}).getByRole('button',{name:/验证实际效果/}).click();
  const currentProject=(await app.inject({method:'GET',url:'/api/migrations',headers:{authorization:`Bearer ${token}`}})).json()[0];
  blockJudge=true;
  const workbench=page.getByRole('region',{name:'持续改进任务'});
  const taskStarted=page.waitForResponse(r=>r.url().endsWith('/improvement-tasks')&&r.request().method()==='POST',{timeout:30_000});void taskStarted.catch(()=>{});
  await workbench.getByRole('button',{name:'开始持续改进',exact:true}).click();assert.equal((await taskStarted).status(),200);
  await expect.poll(()=>blockedJudgeRequests,{timeout:STEP}).toBeGreaterThan(0);
  await workbench.getByRole('button',{name:'停止此任务',exact:true}).click();
  await expect(workbench.getByText('已停止',{exact:true}).first()).toBeVisible({timeout:STEP});
  const stopped=(await app.inject({method:'GET',url:`/api/migrations/${currentProject.id}/improvement-tasks`,headers:{authorization:`Bearer ${token}`}})).json().at(-1);
  assert.equal(stopped.status,'CANCELLED');assert(stopped.finalConsumed);assert.equal(stopped.finalVerified,false);
  const reuse=page.waitForResponse(r=>r.url().endsWith('/improvement-tasks')&&r.request().method()==='POST',{timeout:30_000});void reuse.catch(()=>{});
  await workbench.getByRole('button',{name:'开始持续改进',exact:true}).click();assert.equal((await reuse).status(),409);
  await expect(workbench.getByRole('alert')).toContainText('留出题已经用于最终复核');
  assert.equal((await app.inject({method:'GET',url:`/api/migrations/${currentProject.id}/report`,headers:{authorization:`Bearer ${token}`}})).json().project.candidate.assetId,currentProject.candidate.assetId);
  blockJudge=false;
  pass('ui_cancel_inflight_final_preserves_candidate_and_blocks_holdout_reuse');
  };
  }

  await page.getByRole('button',{name:'进入下载',exact:true}).click();
  const pending=page.waitForEvent('download');
  await page.getByRole('button',{name:'下载迁移包',exact:true}).click();
  const download=await pending,target=path.join(downloads,'migration.zip');await download.saveAs(target);
  const downloadedProject=(await app.inject({method:'GET',url:'/api/migrations',headers:{authorization:`Bearer ${token}`}})).json()[0];
  const delivery=(await app.inject({method:'GET',url:`/api/migrations/${downloadedProject.id}/report`,headers:{authorization:`Bearer ${token}`}})).json();
  assert.equal(download.suggestedFilename().endsWith('-unverified.zip'),delivery.verification.delivery.status!=='VERIFIED');
  const exported=unzipSync(await readFile(target));
  // The Skill keeps its layout; the Script goes where the Skill layout says; the MCP service keeps
  // the paths the agent reported, because the platform did not build it.
  assert(exported['skill/SKILL.md']);
  if(!realAgents)assert(Buffer.from(exported['skill/SKILL.md']).toString('utf8').includes('If the order is unavailable or unapproved, stop'));
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
  pass('candidate_downloaded_with_explicit_acceptance_status');
  await verifyCancellation?.();
  assert.deepEqual(errors,[]);pass('no_browser_errors');
  await page.setViewportSize({width:390,height:900});
  await page.screenshot({path:'reports/migration-v2-ui/revision-mobile.png',fullPage:true});
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));pass('mobile_no_overflow');
  const evaluated=await app.inject({method:'GET',url:`/api/runs/${evaluationJobId}`,headers:{authorization:`Bearer ${token}`}});
  assert.equal(evaluated.statusCode,200);
  acceptedCases=evaluated.json().report.cases.map(c=>({caseId:c.caseId,verdict:c.judge?.goalAssessment?.verdict??'UNKNOWN'}));
  process.stdout.write(`${JSON.stringify({mode:realAgents?(launcherInfo?'REAL_AGENTS_JUDGE_AND_BUILDER':'REAL_AGENTS_AND_JUDGE_WITH_FIXTURE_RUNTIME'):'STUBBED_UI_REGRESSION',checks},null,2)}\n`);
}catch(error){failedAt=error;throw error;}finally{
  // A browser check that fails in CI without a picture is a check nobody can act on.
  if(browser&&failedAt){
    const shot=await page?.screenshot().catch(()=>null);
    if(shot){await mkdir(path.resolve('reports/migration-v2-ui'),{recursive:true}).catch(()=>undefined);
      await writeFile(path.resolve('reports/migration-v2-ui/failure.png'),shot).catch(()=>undefined);}
  }
  if(browser)await browser.close();
  if(proxy){proxy.closeAllConnections();await close(proxy);}
  await app.close();
  if(resumeData||process.env.MIGRATION_TEST_RETAIN_DATA==='true')process.stderr.write(`Retained private test data: ${data}\n`);
  else await rm(data,{recursive:true,force:true});
  await rm(downloads,{recursive:true,force:true});
  if(launcherInfo)delete process.env.MIGRATION_UI_LAUNCHER_CREDENTIAL;
  fixtureServer.closeAllConnections();await close(fixtureServer);
  await writeAcceptanceResult([{skillId:'openjiuwen-portability-acceptance',passed:!failedAt,
    provenance:{diagnosis:realAgents?(resumeData?'REUSED_REAL':'REAL'):'STUBBED',generation:realAgents?(resumeData?'REUSED_REAL':'REAL'):'STUBBED',
      execution:launcherInfo?'REAL':'STUBBED',judge:realAgents?'REAL':'STUBBED'},
    cases:acceptedCases,checks,phases:[
      ...(checks.includes('mixed_choices_generated_with_business_code')?['migration']:[]),
      ...(checks.includes('script_and_mcp_technical_validation')?['technical']:[]),
      ...(acceptedCases.length?['assessment']:[]),
      ...(checks.includes('candidate_downloaded_with_explicit_acceptance_status')?['export']:[]),
    ]}]);
}
