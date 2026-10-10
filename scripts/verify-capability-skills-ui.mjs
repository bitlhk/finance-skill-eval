import {approveMigrationPlanThroughUi} from './lib/verify-reuse-plan-ui.mjs';
/** Fresh real-model UI acceptance of independent capability-boundary Skills. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {cp,mkdtemp,mkdir,readFile,readdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
import {zipSync} from 'fflate';
import {parse as parseYaml} from 'yaml';
import {createEvaluationService} from '../dist/service/server.js';
import {analyzeWithAgent,implementWithAgent} from '../dist/migration/infrastructure/migration-agent.js';
import {capabilitySkills,supplierSuite,ledgerSuite,ledgerFixture} from '../acceptance/capability-migration/manifest.mjs';
import {verifyImprovementThroughUi} from './lib/verify-improvement-ui.mjs';
import {verifyReuseDeliveryThroughUi} from './lib/verify-reuse-delivery-ui.mjs';
import {writeAcceptanceResult} from './lib/migration-acceptance-results.mjs';

assert(process.env.MIGRATION_TEST_LAUNCHER_INFO,'A private live real-model Launcher is required');
const resumeData=process.env.MIGRATION_TEST_RESUME_DATA;
const selected=process.env.CAPABILITY_TEST_SKILLS?.split(',').map(s=>s.trim())??Object.keys(capabilitySkills);
assert(selected.length&&new Set(selected).size===selected.length&&selected.every(id=>Object.hasOwn(capabilitySkills,id)));
assert(!resumeData||selected.length===1,'Resume requires one explicitly selected Skill');
const root=process.cwd(),fixtures=path.join(root,'acceptance/capability-migration');
const privateDir=await mkdtemp(path.join(os.tmpdir(),'capability-skills-ui-'));
if(resumeData)await cp(resumeData,path.join(privateDir,'data'),{recursive:true});
const report=path.resolve(`reports/capability-skills-ui-${Date.now()}`);await mkdir(report,{recursive:true});
const info=JSON.parse(await readFile(process.env.MIGRATION_TEST_LAUNCHER_INFO,'utf8'));assert.equal(info.status,'READY');
process.env.MIGRATION_CAPABILITY_LAUNCHER_TOKEN=info.token;
process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS='1';
// Execution and Judge use the real configured model, never a canned reply.
const cfg=JSON.parse(await readFile(path.join(root,'.runtime.local.json'),'utf8'));
const [modelId,model]=Object.entries(cfg.models).find(([,m])=>m.enabled!==false);
Object.assign(process.env,{FINANCE_EVAL_MIGRATION_AGENT:'on',FINANCE_EVAL_AGENT_ATTEMPTS:'1',
  FINANCE_EVAL_JUDGE_PROVIDER:'openai_compatible',FINANCE_EVAL_JUDGE_BASE_URL:model.baseUrl,
  FINANCE_EVAL_JUDGE_API_KEY:model.apiKey,FINANCE_EVAL_JUDGE_MODEL:model.upstreamModelId??modelId,
  FINANCE_EVAL_JUDGE_REQUEST_DEFAULTS:JSON.stringify({...model.extraBody,max_tokens:32000})});
if(process.env.MIGRATION_TEST_OPTIMIZER_ROLE==='MIGRATION')for(const suffix of ['BASE_URL','API_KEY','MODEL','PROVIDER','REQUEST_DEFAULTS','TIMEOUT_MS']){
  const value=process.env[`FINANCE_EVAL_MIGRATION_${suffix}`];
  if(value!==undefined)process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`]=value;else delete process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`];
}
const opts={projectRoot:root,modelId,providerId:model.providerId??'service-execution',timeoutMs:900000};
let current='',app,browser;const outcomes=[],businessCalls=[];
const business=createServer((req,res)=>{
  let id='';try{if(req.method==='GET'&&req.url?.startsWith('/ledger/'))id=decodeURIComponent(req.url.slice('/ledger/'.length));}catch{}
  const ledger=ledgerFixture(id);
  businessCalls.push({customerId:id,found:!!ledger});
  res.writeHead(ledger?200:404,{'content-type':'application/json'});res.end(JSON.stringify(ledger??{error:'NOT_FOUND'}));
});
await new Promise(r=>business.listen(0,'127.0.0.1',r));
const businessUrl=`http://127.0.0.1:${business.address().port}`;
async function archive(id){
  const directory=path.join(fixtures,id,'source'),files={};
  for(const entry of await readdir(directory,{recursive:true,withFileTypes:true})){
    if(!entry.isFile()||entry.name.endsWith('.pyc'))continue;
    const filename=path.join(entry.parentPath,entry.name),relative=path.relative(directory,filename).replaceAll('\\','/');
    if(relative.split('/').some(s=>s.startsWith('.')))continue;
    files[relative]=await readFile(filename);
  }
  return Buffer.from(zipSync(files));
}
const token='capability-skills-private-test';
async function api(method,url,payload){
  const r=await app.inject({method,url,headers:{authorization:`Bearer ${token}`},...(payload===undefined?{}:{payload})});
  assert.equal(r.statusCode,200,`${method} ${url}: ${r.statusCode}`);return r.json();
}
async function privateRecord(name,value){await writeFile(path.join(privateDir,`${current}-${name}.json`),JSON.stringify(value,null,2));}
try{
  app=await createEvaluationService({rootDirectory:root,dataDirectory:path.join(privateDir,'data'),accessToken:token,publicDemo:false,
    migrationAnalyzer:async input=>{console.log(current+' A2 START');const result=await analyzeWithAgent(input,opts);await privateRecord('a2-'+Date.now(),result);console.log(current+' A2 '+result.status);return result;},
    migrationImplementer:async input=>{console.log(current+' A4 START');const result=await implementWithAgent(input,opts);await privateRecord('a4-'+Date.now(),result);console.log(current+' A4 '+result.status);return result;}});
  app.log.level='error';
  const capabilitiesResponse=await fetch(info.baseUrl+'v1/runtime-capabilities',{headers:{authorization:`Bearer ${info.token}`},signal:AbortSignal.timeout(10000)});
  assert.equal(capabilitiesResponse.status,200,'Launcher capabilities are unavailable');const capabilities=await capabilitiesResponse.json();
  if(selected.some(id=>capabilitySkills[id].native.length)){
    for(const name of ['read_file','list_files'])assert(capabilities.nativeCapabilities?.some(c=>c.name===name),`Enable the Launcher native ${name} contract before acceptance`);
  }
  if(selected.includes('payment-exception'))assert(!capabilities.nativeCapabilities?.some(c=>c.name==='request_approval'),'Expected-gap acceptance requires a Launcher without human approval');
  const env=await api('POST','/api/environments',{name:'多能力真实 Launcher',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:info.baseUrl,credentialEnv:'MIGRATION_CAPABILITY_LAUNCHER_TOKEN'});
  const url=await app.listen({host:'127.0.0.1',port:0});
  browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH?{executablePath:process.env.CHROMIUM_PATH}:{})});
  for(current of selected){
    const spec=capabilitySkills[current],outcome={skillId:current,passed:false,expectation:spec.expected,checks:[],cases:[],phases:[],
      provenance:{diagnosis:'NOT_RUN',generation:'NOT_RUN',execution:'NOT_RUN',judge:'NOT_RUN'}};
    const ctx=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1100}}),page=await ctx.newPage();
    const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());let phase='diagnosis';
    try{
      console.log(current+' UI START');await page.goto(url);await page.getByLabel('访问令牌').fill(token);
      await page.getByRole('button',{name:'进入工作区',exact:true}).click();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
      let project,base,rep;
      if(resumeData){
        const projects=await api('GET','/api/migrations');assert.equal(projects.length,1);
        project=projects[0];assert.equal(project.source.skillId,current);assert(project.candidate);
        base=`/api/migrations/${project.id}`;outcome.provenance.diagnosis='REUSED_REAL';outcome.provenance.generation='REUSED_REAL';
        await page.locator('.migration-project').filter({has:page.getByText(project.name,{exact:true})}).getByRole('button',{name:'继续处理',exact:true}).click();
      }else{
      await page.getByRole('button',{name:'新建迁移',exact:true}).click();
      const inspect=page.waitForResponse(r=>r.url().endsWith('/inspect')&&r.request().method()==='POST',{timeout:900000});void inspect.catch(()=>{});
      await page.locator('input[type=file]').first().setInputFiles({name:current+'.zip',mimeType:'application/zip',buffer:await archive(current)});assert.equal((await inspect).status(),200);outcome.provenance.diagnosis='REAL';
      project=(await api('GET','/api/migrations')).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))[0];base=`/api/migrations/${project.id}`;
      rep=await api('GET',base+'/report');await privateRecord('initial-report',rep);
      assert.equal(rep.inspection.dependencyAnalysis?.status,'COMPLETE','Fresh source diagnosis must close without invented dependencies');
      for(const [index,tool] of rep.inspection.tools.entries()){
        assert.equal(current,'receivables-ledger','Native capabilities must not become business tools');
        const card=page.locator('.diagnosis-tool').nth(index);await expect(card.locator('h3')).toContainText(tool.name);
        await card.getByLabel('转换形式').selectOption('MCP');await card.getByLabel('实现语言').selectOption('python');
      }
      await approveMigrationPlanThroughUi(page);
await page.getByRole('button',{name:'确认方案，进入生成',exact:true}).click();phase='generation';
      const generated=page.waitForResponse(r=>r.url().endsWith('/generate')&&r.request().method()==='POST',{timeout:950000});void generated.catch(()=>{});
      await page.getByRole('button',{name:'开始生成',exact:true}).click();assert.equal((await generated).status(),200);outcome.provenance.generation='REAL';
      }
      rep=await api('GET',base+'/report');assert(rep.project.candidate);await privateRecord('generated-report',rep);
      if(current==='receivables-ledger'){
        const services=rep.project.portableGenerations??[];
        assert.equal(services.length,2);assert(services.every(g=>g.form==='MCP'));
        assert.equal(new Set(services.map(g=>JSON.stringify([g.start,g.prepare]))).size,1,'Tool-owned handles need one shared MCP service');
        outcome.checks.push('business_state_preserved_in_one_mcp_service');
      }
      const nav=page.getByRole('navigation',{name:'迁移步骤'});
      await nav.getByRole('button',{name:/Runtime 适配与登记/}).click();phase='runtime';
      if(spec.native.length){
        await page.getByLabel('已有 Runtime',{exact:true}).selectOption(env.environmentId);
        const reinspect=page.waitForResponse(r=>r.url().endsWith('/inspect/source')&&r.request().method()==='POST',{timeout:900000});void reinspect.catch(()=>{});
        await page.getByRole('button',{name:'结合此 Runtime 重新诊断',exact:true}).click();assert.equal((await reinspect).status(),200);
        const requirements=await api('GET',base+'/runtime-requirements');await privateRecord('requirements',requirements);
        for(const name of spec.native)assert(requirements.requiredCapabilities.some(c=>c.name===name),`Missing source capability ${name}`);
        const reuse=page.waitForResponse(r=>r.url().endsWith('/runtime-reuse')&&r.request().method()==='POST');void reuse.catch(()=>{});
        await page.getByRole('button',{name:'核对并使用',exact:true}).click();const reused=await reuse;
        if(spec.expected==='BLOCKED'){
          assert.equal(reused.status(),409);await expect(page.getByRole('alert').filter({hasText:'现有 Runtime 尚不能确认满足需求'})).toContainText('request_approval');
          const unchanged=await api('GET',base+'/report');assert(!unchanged.project.runtimeReuse&&!unchanged.project.runtimeDelivery);
          const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'下载能力需求 YAML',exact:true}).click();
          const downloaded=await downloading,content=await readFile(await downloaded.path(),'utf8'),exported=parseYaml(content);
          for(const name of spec.native)assert(exported.requiredCapabilities.some(c=>c.name===name),`Export dropped ${name}`);
          outcome.checks.push('partial_native_match_rejected','complete_builder_requirements_exported','no_fake_runtime_binding');
          outcome.cases=[{caseId:'partial-native-match',verdict:'PASS'},{caseId:'complete-requirements-export',verdict:'PASS'}];
          outcome.phases=['diagnosis','generation','expected-block'];outcome.passed=true;
          assert.deepEqual(errors,[]);
          await page.screenshot({path:path.join(report,current+'.png'),fullPage:true});continue;
        }
        assert.equal(reused.status(),200);await expect(page.getByText('已有 Runtime 的能力合同已核对',{exact:true})).toBeVisible();
        outcome.checks.push('all_required_native_contracts_verified');
      }else assert.equal((await api('GET',base+'/runtime-requirements')).status,'NOT_REQUIRED','Tool-owned state must not be sent to Builder');
      await page.locator('.stage-actions').getByRole('button',{name:'验证能否运行',exact:true}).click();phase='configuration';
      rep=await api('GET',base+'/report');
      if(resumeData&&await page.locator('.runtime-config-ready > summary').count())await page.locator('.runtime-config-ready > summary').click();
      for(const d of rep.project.sourceInspection.dependencyAnalysis.dependencies.filter(d=>d.owner==='RUNTIME'&&d.action==='INJECT')){
        assert.equal(current,'receivables-ledger');assert(/LEDGER_SERVICE_URL/u.test(JSON.stringify(d)),'Unexpected fixture dependency');
        const card=page.locator('[data-dependency]').filter({hasText:d.name}).first();await card.locator('input').first().fill(businessUrl);
        const saved=page.waitForResponse(r=>r.url().includes('/runtime-configuration/')&&r.request().method()==='PUT');
        await card.getByRole('button',{name:'保存服务配置',exact:true}).click();assert.equal((await saved).status(),200);
      }
      if(current==='receivables-ledger'){
        phase='technical';
        const probes={query_receivables:{customer_id:'AR-EMPTY'},summarize_receivables:{snapshot_ref:'invalid-technical-probe'}};
        for(const tool of rep.inspection.tools){
          assert(probes[tool.name],'Unexpected business tool');
          const card=page.locator(`article[id="migration-tool-${tool.toolId}"]`);
          await card.getByText('高级设置：覆盖自动测试参数',{exact:true}).click();await card.locator('textarea').fill(JSON.stringify(probes[tool.name]));
          const trial=page.waitForResponse(r=>r.url().endsWith('/validate/technical')&&r.request().method()==='POST',{timeout:300000});void trial.catch(()=>{});
          await card.getByRole('button',{name:/^(开始|重新)试运行$/u}).click();const response=await trial;assert.equal(response.status(),200);
          const result=await response.json();await privateRecord('technical-'+tool.name,result);assert.equal(result.status,'PASSED');
        }
        outcome.checks.push('mcp_protocol_smoke_tests');
      }
      // Isolated invalid-handle probes above check protocol behavior only. A real
      // query snapshot and its actual business consumption must pass the agent cases below.
      await page.locator('.stage-actions').getByRole('button',{name:'验证实际效果',exact:true}).click();phase='evaluation';
      const suite=current==='supplier-dossier'?supplierSuite:ledgerSuite;
      const improvement=await verifyImprovementThroughUi({page,api,base,suite,environmentId:env.environmentId,verifyExternalEvidence:async()=>{
        const task=(await api('GET',base+'/improvement-tasks')).at(-1),job=await api('GET',`/api/runs/${task.finalJobId}`);
        await privateRecord('final-job',job);
        if(current==='supplier-dossier'){
          const calls=job.report.cases.find(c=>c.caseId==='supplier-consistent').right.toolCalls;
          for(const name of spec.native)assert(calls.some(c=>c.name===name&&c.status==='completed'));
          return ['both_native_tools_executed_in_one_case'];
        }
        for(const id of ['ledger-large','ledger-empty','ledger-decimals']){
          const calls=job.report.cases.find(c=>c.caseId===id).right.toolCalls.map(c=>c.name);
          assert(calls.indexOf('query_receivables')>=0&&calls.indexOf('summarize_receivables')>calls.indexOf('query_receivables'));
        }
        assert(businessCalls.some(c=>c.customerId==='AR-200'&&c.found));return ['real_shared_mcp_lifecycle_and_business_service'];
      }});
      outcome.provenance.execution='REAL';outcome.provenance.judge='REAL';
      outcome.cases=improvement.cases;outcome.checks.push(...improvement.externalChecks);
      phase='reuse-acceptance';
      outcome.deliveryEvidence=await verifyReuseDeliveryThroughUi({page,api,base,
        persistEvidence:async value=>privateRecord('delivery-'+Date.now(),value),downloadPath:path.join(privateDir,current+'-verified.zip')});
      outcome.phases=['migration','technical','improvement','final-verification','adoption','reuse-acceptance','verified-export'];outcome.passed=true;
      assert.deepEqual(errors,[]);await page.screenshot({path:path.join(report,current+'.png'),fullPage:true});
    }catch(error){outcome.passed=false;outcome.failurePhase=phase;outcome.failureType=error.name;await privateRecord('failure',{error:String(error),page:await page.locator('body').innerText().catch(()=>'' )});await page.screenshot({path:path.join(report,current+'-failure.png'),fullPage:true}).catch(()=>{});console.error(current+' FAILED '+phase+' '+error.name);}
    finally{await ctx.close();outcomes.push(outcome);await writeFile(path.join(report,'result.json'),JSON.stringify({passed:outcomes.length===selected.length&&outcomes.every(o=>o.passed),outcomes},null,2));console.log(current+' FINISHED '+outcome.passed);}
  }
}finally{
  await browser?.close();await app?.close();await new Promise(r=>business.close(r));delete process.env.MIGRATION_CAPABILITY_LAUNCHER_TOKEN;
  await writeAcceptanceResult(outcomes);console.log(JSON.stringify({report,privateDir,passed:outcomes.every(o=>o.passed)}));
}
if(outcomes.length!==selected.length||outcomes.some(o=>!o.passed))process.exitCode=1;
