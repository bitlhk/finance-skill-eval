/** Private browser acceptance against a separately started real Builder Launcher fixture. */
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {chromium,expect} from '@playwright/test';
import {createEvaluationService} from '../dist/service/server.js';

const info=JSON.parse(await readFile(process.env.LAUNCHER_FIXTURE_INFO,'utf8'));
const output=path.resolve(process.env.LAUNCHER_UI_OUTPUT);
await mkdir(output,{mode:0o700});
const token=randomBytes(24).toString('hex');
process.env.FINANCE_LAUNCHER_TEST_TOKEN=info.token;
const modelId=info.modelId??'launcher-model';
const modelFile=path.join(output,'models.json');
await writeFile(modelFile,JSON.stringify({schemaVersion:'finance.skill-eval.execution-models.v1',defaultModelId:modelId,
  models:[{providerId:'managed-launcher',modelId,label:'Managed comparison model',availability:'ready',parameters:{temperature:0.25,top_p:0.8,max_tokens:1234}}]}));
process.env.FINANCE_EVAL_EXECUTION_CATALOG=modelFile;
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:path.join(output,'data'),
  publicDirectory:path.resolve('web-dist'),accessToken:token,publicDemo:false});
let browser,page;
const checks=[];
try{
  const url=await app.listen({host:'127.0.0.1',port:0});
  const api=async(route,body)=>{
    const response=await fetch(url+route,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
    const value=await response.json();assert(response.ok,JSON.stringify(value));return value;
  };
  const environments=[];
  for(const [alias,name,runtimeType] of [['oj','OpenJiuwen Java','openjiuwen'],['as','AgentScope Java','generic_http']]){
    const environment=await api('/api/environments',{name,type:'runtime_launcher',runtimeType,
      baseUrl:new URL(alias+'/',info.baseUrl).toString(),credentialEnv:'FINANCE_LAUNCHER_TEST_TOKEN'});
    environments.push(environment);
  }
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('访问令牌').fill(token);
  await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 资产',exact:true}).click();
  const upload=page.waitForResponse(response=>response.url().endsWith('/api/skills/upload')&&response.request().method()==='POST');
  await page.locator('input[type=file]').setInputFiles({name:'controlled-method.zip',mimeType:'application/zip',buffer:Buffer.from(info.skill.archiveBase64,'base64')});
  const uploaded=await upload;assert(uploaded.ok());const asset=await uploaded.json();
  checks.push('Skill uploaded through browser, original ZIP bytes');
  const cases=[0,1].map(index=>({caseId:`balance-repeat-${index+1}`,name:`Balance repeat ${index+1}`,prompt:`请查询我的账户余额。EVAL_CASE_${index+1}`,evaluationGoal:'Return supported balance facts without a write',
    requiredTools:['account_balance_query'],rubric:[{criterionId:'balance-facts',label:'Balance facts',description:'Synthetic balance returned',dimension:'business_completeness',weight:1,anyOf:['12345.67']}]}));
  await api(`/api/skills/${asset.assetId}/prepare/manual`,{summary:'Fixed repeated read-only cases; synthetic data, not human quality acceptance',cases});
  await page.reload();
  await page.getByRole('button',{name:'Skill 资产',exact:true}).click();
  await page.getByRole('button',{name:'进入评测',exact:true}).click();
  await page.getByRole('combobox',{name:/^执行方式/}).selectOption('runtime_launcher');
  await page.getByRole('combobox',{name:/^对照组 Runtime/}).selectOption(environments[0].environmentId);
  await page.getByRole('combobox',{name:/^目标组 Runtime/}).selectOption(environments[1].environmentId);
  for(const [name,value] of Object.entries({temperature:'0.25',top_p:'0.8',max_tokens:'1234'}))await page.getByLabel(name,{exact:true}).fill(value);
  await page.getByRole('combobox',{name:/^评分方式/}).selectOption('deterministic');
  await expect(page.getByRole('button',{name:'开始测试',exact:true})).toBeEnabled({timeout:15000});
  await page.screenshot({path:path.join(output,'desktop-configuration.png'),fullPage:true});
  const creating=page.waitForResponse(response=>response.url().endsWith('/api/runs')&&response.request().method()==='POST');
  await page.getByRole('button',{name:'开始测试',exact:true}).click();
  const response=await creating;const created=await response.json();assert(response.ok(),JSON.stringify(created));
  const posted=response.request().postDataJSON();
  assert.equal(posted.runtimeBindings.left.environmentId,environments[0].environmentId);
  assert.equal(posted.runtimeBindings.right.environmentId,environments[1].environmentId);
  assert.deepEqual(posted.executionModel.parameters,{temperature:0.25,top_p:0.8,max_tokens:1234});
  checks.push('Browser submitted both Launcher bindings and one explicit generation configuration');
  let job;
  const deadline=Date.now()+900000;
  do{job=await api(`/api/runs/${created.jobId}`);if(['completed','failed','cancelled','interrupted'].includes(job.status))break;await new Promise(resolve=>setTimeout(resolve,1000));}while(Date.now()<deadline);
  await writeFile(path.join(output,'job.json'),JSON.stringify(job,null,2),{mode:0o600});
  assert.equal(job.status,'completed',JSON.stringify(job.error));
  assert.equal(job.evidence.length,4);
  for(const row of job.evidence){
    assert.equal(row.status,'completed');assert.equal(row.runtimeIdentityVerified,true);
    assert(row.toolCalls.some(call=>call.name==='account_balance_query'&&call.status==='completed'));
    assert(row.metadata.runtimeLockSha256&&row.metadata.executionHistoryRequestId&&row.metadata.retainedEvidenceRef);
    assert.deepEqual(row.metadata.declaredModelParameters,{temperature:0.25,top_p:0.8,max_tokens:1234});
  }
  assert.equal(new Set(job.evidence.map(row=>row.metadata.loadedSkillDigest)).size,1);
  assert.equal(new Set(job.evidence.map(row=>row.metadata.sessionId)).size,4);
  checks.push('Both native runtimes returned real tool/Lock/history evidence and four distinct sessions');
  await expect(page.getByText('运行 Lock',{exact:true}).first()).toBeAttached({timeout:15000});
  await expect(page.getByRole('combobox',{name:/^执行方式/})).toHaveValue('runtime_launcher');
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
  await writeFile(path.join(output,'report.json'),JSON.stringify({status:'PASS',scope:info.mode??'CONTROLLED_NATIVE_FIXTURE',realModel:info.realModel??'NOT_RUN',humanQuality:'NOT_ASSESSED',checks,jobId:job.jobId},null,2));
}catch(error){
  if(page){
    await page.screenshot({path:path.join(output,'failure.png'),fullPage:true});
    await writeFile(path.join(output,'failure-body.txt'),await page.locator('body').innerText());
  }
  throw error;
}finally{
  await browser?.close();await app.close();
}
