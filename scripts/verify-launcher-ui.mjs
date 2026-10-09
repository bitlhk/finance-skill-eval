/** Private browser acceptance against a separately started real Builder Launcher fixture. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createEvaluationService} from '../dist/service/server.js';
import {zipSync} from 'fflate';
import {installNativeSample} from './install-native-sample.mjs';
import {loadEvalPack} from '../dist/eval-pack.js';
import {controlledGoalJudge} from './controlled-goal-judge.mjs';
import {fixtureExecution} from './native-fixture-profile.mjs';
import {launcherGenerationSchema} from '../dist/runtime-launcher.js';

const fixtureMap=process.env.LAUNCHER_FIXTURE_MAP
  ?JSON.parse(await readFile(process.env.LAUNCHER_FIXTURE_MAP,'utf8')):null;
const fixtures=fixtureMap?Object.fromEntries(await Promise.all(Object.entries(fixtureMap).map(async([key,file])=>[key,JSON.parse(await readFile(file,'utf8'))]))):null;
const info=fixtures?.oj??JSON.parse(await readFile(process.env.LAUNCHER_FIXTURE_INFO,'utf8'));
const realModel=fixtureExecution({openjiuwen:fixtures?.oj??info,agentscope:fixtures?.as??info},
  process.env.LAUNCHER_UI_EXECUTION_MODE??'CONTROLLED');
const generation=launcherGenerationSchema.omit({schemaVersion:true}).parse(
  JSON.parse(process.env.LAUNCHER_UI_GENERATION??'{"temperature":0.25,"top_p":0.8,"max_tokens":1234}'));
const output=path.resolve(process.env.LAUNCHER_UI_OUTPUT);
await mkdir(output,{mode:0o700});
const token=randomBytes(24).toString('hex');
process.env.FINANCE_LAUNCHER_TEST_TOKEN=info.token;
const modelId=info.modelId??'launcher-model';
const caseFiles=info.runtimes.oj.requiredToolNames.includes('read_case_file');
const modelFile=path.join(output,'models.json');
await writeFile(modelFile,JSON.stringify({schemaVersion:'finance.skill-eval.execution-models.v1',defaultModelId:modelId,
  models:[{providerId:'managed-launcher',modelId,label:realModel==='LIVE'?'Approved live native model':'Controlled native model',availability:'ready',parameters:generation}]}));
process.env.FINANCE_EVAL_EXECUTION_CATALOG=modelFile;
const prebuilt=process.env.LAUNCHER_PREBUILT_FLOW==='true';
if(prebuilt){
  const pack=await loadEvalPack(path.resolve('packs/finance/native-readonly-balance/eval.yaml'));
  for(const fixture of fixtures?Object.values(fixtures):[info])assert.equal(fixture.bankFixture?.id,pack.metadata?.fixtureVersion,
    'PREBUILT_FIXTURE_MISMATCH: use the bank fixture pinned by this evaluation pack; do not score a different bank snapshot');
}
const builtin=prebuilt?await installNativeSample(path.join(output,'data')):null;
const judge=await controlledGoalJudge();
const accountMode=process.env.LAUNCHER_ACCOUNT_WORKSPACES==='true';
const origin='https://eval.example.test',subject='studio_native_alice';
const accountHeaders=name=>accountMode?{'x-demo-user':name,origin}:{};
let app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:path.join(output,'data'),
  publicDirectory:path.resolve('web-dist'),accessToken:token,publicDemo:false});
let browser,page;
const checks=[];
try{
  let url=await app.listen({host:'127.0.0.1',port:0}),seedReady=false;
  const api=async(route,body)=>{
    const response=await fetch(url+route,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...(seedReady?accountHeaders(subject):{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json();assert(response.ok,JSON.stringify(value));return value;
  };
  const environments=[];
  for(const [alias,name,runtimeType] of [['oj','OpenJiuwen Java','openjiuwen'],['as','AgentScope Java','agentscope']]){
    const current=fixtures?.[alias]??info;
    const credential='FINANCE_LAUNCHER_TEST_TOKEN_'+alias.toUpperCase();process.env[credential]=current.token;
    const environment=await api('/api/environments',{name,type:'runtime_launcher',runtimeType,
      baseUrl:new URL(alias+'/',current.baseUrl).toString(),credentialEnv:credential});
    environments.push(environment);
  }
  if(accountMode){
    assert(prebuilt,'Account-mode native probe requires the immutable prebuilt sample');
    await app.close();
    const seed=path.join(output,'reviewed-seed');await mkdir(seed,{mode:0o700});
    for(const name of ['skills','environments','preparations'])await cp(path.join(output,'data',name),path.join(seed,name),{recursive:true});
    const manifest=JSON.parse(execFileSync(process.execPath,['scripts/workspace-seed-manifest.mjs',seed],{encoding:'utf8'}));
    await writeFile(path.join(output,'seed-manifest.json'),JSON.stringify(manifest,null,2));
    app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:path.join(output,'account-data'),
      publicDirectory:path.resolve('web-dist'),accessToken:token,publicDemo:false,workspaceMode:'account',
      workspaceSubject:undefined,workspaceOrigin:origin,workspaceSeedDirectory:seed,workspaceSeedSha256:manifest.sha256});
    url=await app.listen({host:'127.0.0.1',port:0});seedReady=true;
  }
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  if(accountMode)await page.route(`${url}/api/**`,async route=>{
    const headers={...route.request().headers(),authorization:`Bearer ${token}`,...accountHeaders(subject)};
    if(route.request().method()==='GET')await route.continue({headers});
    else await route.fulfill({response:await route.fetch({headers,maxRedirects:0})});
  });
  await page.goto(url);
  if(!accountMode){
    await page.getByLabel('访问令牌').fill(token);
    await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  }
  let asset;
  if(prebuilt){
    asset=builtin;
    await page.locator('.skill-list-item').filter({has:page.getByRole('heading',{name:'账户余额核验',exact:true})}).getByRole('button',{name:'进入评测',exact:true}).click();
    checks.push('Prebuilt immutable Skill was selected from the public catalog with its fixed evaluation pack');
  }else if(process.env.LAUNCHER_MIGRATION_FLOW==='true'){
    await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
    await page.getByRole('button',{name:'新建迁移',exact:true}).click();
    const source=await readFile('examples/native-readonly-balance/SKILL.md');
    const inspected=page.waitForResponse(response=>response.url().endsWith('/inspect')&&response.request().method()==='POST',{timeout:650000});
    await page.locator('input[type=file][multiple]').setInputFiles({name:'native-method.zip',mimeType:'application/zip',buffer:Buffer.from(zipSync({'SKILL.md':source}))});
    const diagnostic=await inspected;assert(diagnostic.ok(),JSON.stringify(await diagnostic.json()));
    await expect(page.getByRole('heading',{name:'复用已准入工具',exact:true})).toBeVisible({timeout:600000});
    const projects=await api('/api/migrations');assert.equal(projects.length,1);
    await writeFile(path.join(output,'migration-before-generation.json'),JSON.stringify(await api(`/api/migrations/${projects[0].id}/report`),null,2));
    const binding=page.locator('section').filter({has:page.getByRole('heading',{name:'复用已准入工具',exact:true})}).last();
    await binding.getByLabel('OpenJiuwen Java',{exact:true}).check();
    await binding.getByLabel('AgentScope Java',{exact:true}).check();
    await binding.getByRole('button',{name:'检查已准入合同',exact:true}).click();
    await binding.getByLabel('已核对工具合同和用途；绑定不代表候选已执行通过').check();
    await page.screenshot({path:path.join(output,'migration-native-binding.png'),fullPage:true});
    const generating=page.waitForResponse(response=>response.url().endsWith('/native-candidate')&&response.request().method()==='POST',{timeout:600000});
    await binding.getByRole('button',{name:'绑定并生成候选',exact:true}).click();
    const response=await generating;const generated=await response.json();
    await writeFile(path.join(output,'migration-generated.json'),JSON.stringify(generated,null,2));
    assert(response.ok(),JSON.stringify(generated));assert(generated.candidate);
    asset=generated.candidate;
    assert.equal(generated.nativeBindings.bindings.targets.length,2);
    assert.equal(generated.nativeBindings.candidateDigest,asset.artifactSha256);
    checks.push('Browser uploaded, analyzed and explicitly bound admitted contracts for both runtimes; immutable candidate, no formal publication');
  }else{
  await page.getByRole('button',{name:'Skill 资产',exact:true}).click();
  const upload=page.waitForResponse(response=>response.url().endsWith('/api/skills/upload')&&response.request().method()==='POST');
  const archive=process.env.LAUNCHER_UPLOAD_SAMPLE==='true'
    ?Buffer.from(zipSync({'SKILL.md':await readFile('examples/native-readonly-balance/SKILL.md')}))
    :Buffer.from(info.skill.archiveBase64,'base64');
  await page.locator('input[type=file]').setInputFiles({name:'controlled-method.zip',mimeType:'application/zip',buffer:archive});
  const uploaded=await upload;assert(uploaded.ok());asset=await uploaded.json();
  checks.push('Skill uploaded through browser, original ZIP bytes');
  }
  const cases=[0,1].map(index=>({caseId:`balance-repeat-${index+1}`,name:`Balance repeat ${index+1}`,prompt:`请查询我的账户余额。EVAL_CASE_${index+1}`,evaluationGoal:'Return supported balance facts without a write',
    requiredTools:['account_balance_query',...(caseFiles?['read_case_file']:[])],
    ...(caseFiles?{workspaceFiles:[{path:'case.txt',content:`BROWSER_CASE_FILE_${index+1}`}]}:{}),
    rubric:[{criterionId:'balance-facts',label:'Balance facts',description:'Synthetic balance returned',dimension:'business_completeness',weight:1,anyOf:['(?<![\\d,])12,?345\\.67(?!\\d)']}]}));
  if(!prebuilt){
    await api(`/api/skills/${asset.assetId}/prepare/manual`,{summary:'Fixed repeated read-only cases; synthetic data, not human quality acceptance',cases});
    await page.reload();
    await page.getByRole('button',{name:'Skill 资产',exact:true}).click();
    await page.locator(`#asset-${asset.assetId}`).getByRole('button',{name:'进入评测',exact:true}).click();
  }
  await page.getByRole('combobox',{name:/^执行方式/}).selectOption('dual_runtime');
  await page.getByRole('combobox',{name:/^对照组 Runtime/}).selectOption(environments[0].environmentId);
  await page.getByRole('combobox',{name:/^目标组 Runtime/}).selectOption(environments[1].environmentId);
  for(const name of ['temperature','top_p','max_tokens'])await page.getByLabel(name,{exact:true}).fill(String(generation[name]));
  if(generation.thinking)await page.getByRole('combobox',{name:'思考模式',exact:true}).selectOption(generation.thinking.type);
  await expect(page.getByRole('combobox',{name:/^评分方式/})).toHaveValue('model');
  await expect(page.getByRole('button',{name:'开始测试',exact:true})).toBeEnabled({timeout:15000});
  await page.screenshot({path:path.join(output,'desktop-configuration.png'),fullPage:true});
  const creating=page.waitForResponse(response=>response.url().endsWith('/api/runs')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'开始测试',exact:true}).click();
  const response=await creating;const created=await response.json();assert(response.ok(),JSON.stringify(created));
  const posted=response.request().postDataJSON();
  assert.equal(posted.evaluationMode,'candidate_runtime_comparison');
  assert.equal(posted.runtimeBindings.left.environmentId,environments[0].environmentId);
  assert.equal(posted.runtimeBindings.right.environmentId,environments[1].environmentId);
  assert.deepEqual(posted.executionModel.parameters,generation);
  checks.push('Browser submitted both Launcher bindings and one explicit generation configuration');
  let job;
  const deadline=Date.now()+900000;
  do{job=await api(`/api/runs/${created.jobId}`);if(['completed','failed','cancelled','interrupted'].includes(job.status))break;await new Promise(resolve=>setTimeout(resolve,1000));}while(Date.now()<deadline);
  await writeFile(path.join(output,'job.json'),JSON.stringify(job,null,2),{mode:0o600});
  assert.equal(job.status,'completed',JSON.stringify(job.error));
  assert.equal(job.evidence.length,prebuilt?2:4);
  for(const row of job.evidence){
    assert.equal(row.status,'completed');assert.equal(row.runtimeIdentityVerified,true);
    assert(row.toolCalls.some(call=>call.name==='account_balance_query'&&call.status==='completed'));
    if(caseFiles){
      assert(row.toolCalls.some(call=>call.name==='read_case_file'&&call.status==='completed'));
      assert.equal(row.metadata.caseWorkspace.closed,true);
      assert.equal(row.metadata.caseWorkspace.reads.length,1);
      assert(row.metadata.workspaceFilesDigest);
    }
    assert(row.metadata.runtimeLockSha256&&row.metadata.executionHistoryRequestId&&row.metadata.retainedEvidenceRef);
    assert.deepEqual(row.metadata.declaredModelParameters,generation);
  }
  assert.equal(new Set(job.evidence.map(row=>row.metadata.loadedSkillDigest)).size,1);
  assert.equal(new Set(job.evidence.map(row=>row.metadata.sessionId)).size,job.evidence.length);
  assert.equal(judge.calls.length,job.evidence.length);
  for(const item of job.report.cases)for(const side of ['left','right']){
    assert.equal(item.judge.runtimeComparison[side].status,'assessed');
    assert.equal(item.judge.runtimeComparison[side].assessment.verdict,'INDETERMINATE');
  }
  checks.push('Both native runtimes returned tool/Lock/history evidence and a fresh session for every case');
  if(process.env.LAUNCHER_ASSERT_FACTS==='true'){
    assert(!prebuilt,'Use the versioned independent bank acceptance for prebuilt accounts; legacy single-account matcher is not applicable');
    for(const item of job.report.cases){
      for(const row of [item.left,item.right]){
        assert.match(row.output,/(?<![\d,])12,?345\.67(?!\d)/u);
        assert.match(row.output,/CNY|人民币/u);
        assert(row.metadata.toolOutcomes.some(value=>value.capabilityId==='account.balance.query'&&value.resultStatus==='COMPLETED'));
      }
    }
    checks.push('Both sides satisfy the explicit synthetic amount/currency checks; professional quality is not inferred');
  }
  await expect(page.getByText('运行 Lock',{exact:true}).first()).toBeAttached({timeout:15000});
  await expect(page.locator('.run-status.completed').first()).toBeVisible({timeout:15000});
  await expect(page.getByRole('combobox',{name:/^执行方式/})).toHaveValue('dual_runtime');
  await expect(page.getByRole('combobox',{name:/^对照组 Runtime/})).toHaveValue(environments[0].environmentId);
  await expect(page.getByRole('combobox',{name:/^目标组 Runtime/})).toHaveValue(environments[1].environmentId);
  for(const detail of await page.locator('.answer-grid details').all())await detail.evaluate(node=>node.open=true);
  await page.screenshot({path:path.join(output,'desktop-result.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await expect.poll(()=>page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth))).toBeLessThanOrEqual(390);
  const mobile=await page.screenshot({path:path.join(output,'mobile-result.png'),fullPage:true});
  assert.equal(mobile.readUInt32BE(16),390,'Full-page screenshot must not expand beyond the mobile viewport');
  assert.deepEqual(errors,[]);
  checks.push('Desktop and 390px browser rendered real result evidence without page errors or horizontal overflow');
  let secondJob;
  if(accountMode){
    const request=async(name,route,body)=>fetch(url+route,{method:body===undefined?'GET':'POST',
      headers:{authorization:`Bearer ${token}`,...accountHeaders(name),'content-type':'application/json'},
      ...(body===undefined?{}:{body:JSON.stringify(body)})});
    for(const suffix of ['', '/export', '/events'])assert.equal((await request('studio_native_bob',`/api/runs/${job.jobId}${suffix}`)).status,404);
    assert.equal((await request('studio_native_bob',`/api/runs/${job.jobId}/cancel`,{})).status,404);
    const second=await request('studio_native_bob','/api/runs',posted);
    assert.equal(second.status,202);secondJob=await second.json();
    const deadline=Date.now()+900000;
    do{
      secondJob=await (await request('studio_native_bob',`/api/runs/${secondJob.jobId}`)).json();
      if(['completed','failed','cancelled','interrupted'].includes(secondJob.status))break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }while(Date.now()<deadline);
    await writeFile(path.join(output,'second-account-job.json'),JSON.stringify(secondJob,null,2),{mode:0o600});
    assert.equal(secondJob.status,'completed',JSON.stringify(secondJob.error));
    assert.equal(secondJob.evidence.length,job.evidence.length);
    const previousSessions=new Set(job.evidence.map(row=>row.metadata.sessionId));
    const previousInstances=new Set(job.evidence.map(row=>row.metadata.instanceId));
    for(const row of secondJob.evidence){
      assert(row.status==='completed'&&row.runtimeIdentityVerified);
      assert(row.metadata.runtimeLockSha256&&row.metadata.executionHistoryRequestId&&row.metadata.retainedEvidenceRef);
      assert(row.toolCalls.some(call=>call.name==='account_balance_query'&&call.status==='completed'));
      assert.equal(row.metadata.loadedSkillDigest,job.evidence[0].metadata.loadedSkillDigest);
      assert(!previousSessions.has(row.metadata.sessionId));
      assert(row.metadata.instanceId&&!previousInstances.has(row.metadata.instanceId));
      assert.deepEqual(row.metadata.declaredModelParameters,generation);
      if(caseFiles)assert(row.metadata.caseWorkspace.closed&&row.metadata.caseWorkspace.reads.length===1);
    }
    assert.equal(judge.calls.length,job.evidence.length+secondJob.evidence.length);
    assert.equal((await request(subject,`/api/runs/${secondJob.jobId}`)).status,404);
    assert.deepEqual((await (await request(subject,'/api/runs')).json()).runs.map(row=>row.jobId),[job.jobId]);
    assert.deepEqual((await (await request('studio_native_bob','/api/runs')).json()).runs.map(row=>row.jobId),[secondJob.jobId]);
    checks.push('Two account stores independently executed both native runtimes with disjoint sessions/instances and denied cross-account history access');
  }
  await writeFile(path.join(output,'report.json'),JSON.stringify({status:'PASS',scope:info.mode??'CONTROLLED_NATIVE_FIXTURE',realModel,generation,judgeMode:'CONTROLLED_INDETERMINATE',factChecks:process.env.LAUNCHER_ASSERT_FACTS==='true'?'PASSED':'NOT_ASSERTED',humanQuality:'NOT_ASSESSED',checks,jobId:job.jobId,
    accountMode,secondAccountJobId:secondJob?.jobId,sso:accountMode?'SYNTHETIC_TRUSTED_INGRESS':'NOT_TESTED'},null,2));
}catch(error){
  if(page){
    await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});
    await writeFile(path.join(output,'failure-body.txt'),await page.locator('body').innerText());
  }
  throw error;
}finally{
  await writeFile(path.join(output,'judge-calls.json'),JSON.stringify(judge.calls,null,2));
  await browser?.close();await app.close();await judge.close();
}
