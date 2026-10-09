/** Isolated UI contract check. Launcher preflights are fixtures; no Agent is built. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {parse,stringify} from 'yaml';
import {chromium,expect} from '@playwright/test';
import {createEvaluationService} from '../dist/service/server.js';
import {runConfigurationSchema} from '../dist/shared/contracts/run-configuration.js';
import {installNativeSample} from './install-native-sample.mjs';
import {controlledGoalJudge} from './controlled-goal-judge.mjs';

const output=path.resolve(process.argv[2]??'reports/holdout-selection-ui');
await mkdir(output,{recursive:true});
const root=await mkdtemp(path.join(tmpdir(),'eval-holdout-ui-'));
const packDirectory=path.join(root,'packs/finance/native-readonly-balance');
await mkdir(path.dirname(packDirectory),{recursive:true});
await cp('packs/finance/native-readonly-balance',packDirectory,{recursive:true});
await cp('packs/finance/catalog.yaml',path.join(root,'packs/finance/catalog.yaml'));
const manifest=parse(await readFile(path.join(packDirectory,'eval.yaml'),'utf8'));
const holdout=parse(await readFile(path.join(packDirectory,manifest.caseFiles[0]),'utf8'));
holdout.caseId='ui-only-holdout';
holdout.requiredTools=['holdout_only_tool'];
await writeFile(path.join(packDirectory,'cases/ui-holdout.yaml'),stringify(holdout));
manifest.holdoutCaseFiles=['cases/ui-holdout.yaml'];
await writeFile(path.join(packDirectory,'eval.yaml'),stringify(manifest));
await installNativeSample(path.join(root,'data'));
const judge=await controlledGoalJudge();
const app=await createEvaluationService({rootDirectory:root,dataDirectory:path.join(root,'data'),
  publicDirectory:path.resolve('web-dist'),accessToken:'isolated-ui-only',publicDemo:false});
let browser;
const errors=[],posted=[];
let preflights=0,allowHoldout=false;
try{
  const url=await app.listen({host:'127.0.0.1',port:0});
  const response=await app.inject({url:'/api/catalog',headers:{authorization:'Bearer isolated-ui-only'}});
  assert.equal(response.statusCode,200);
  const catalog=response.json(),pack=catalog.evalPacks[0];
  assert.equal(pack.holdoutCaseCount,1);
  assert.deepEqual(pack.holdoutRequiredTools,['holdout_only_tool']);
  assert.equal(JSON.stringify(pack).includes('ui-only-holdout'),false,'Catalog must not expose held-out prompt/rubric');
  const model={providerId:'ui-fixture',modelId:'controlled-model',availability:'ready',parameters:{}};
  catalog.executionRuntimes=['openjiuwen','agentscope'].map(type=>({runtimeId:type,launcherEnvironmentId:type,
    name:type,runtimeType:type,endpoint:'http://127.0.0.1:1/',defaultModelId:model.modelId,mcpEnvironmentIds:[],
    toolCount:3,models:[model],transport:'runtime_launcher'}));
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1366,height:900}});
  page.on('pageerror',error=>errors.push(error.message));
  await page.route(`${url}/api/**`,async route=>{
    const request=route.request(),pathname=new URL(request.url()).pathname;
    if(pathname==='/api/catalog')return route.fulfill({json:catalog});
    if(pathname.endsWith('/preflight')){
      preflights++;
      return route.fulfill({json:{status:'ready',elapsedMs:1,error:null,tools:[],mcpServers:[],
        capabilities:{runtime:{type:pathname.includes('agentscope')?'agentscope':'openjiuwen',version:'UI_FIXTURE'},
          nativeToolNames:['account_balance_query','read_case_file',...(allowHoldout?['holdout_only_tool']:[])],
          features:{externalMcp:false},limits:{minPrimaryTools:0}}}});
    }
    if(pathname==='/api/runs'&&request.method()==='POST'){
      posted.push(runConfigurationSchema.parse(request.postDataJSON()));
      return route.fulfill({status:409,json:{message:'UI_PROBE_EXECUTION_DISABLED'}});
    }
    await route.continue({headers:{...request.headers(),authorization:'Bearer isolated-ui-only'}});
  });
  await page.goto(url);
  await page.locator('.skill-list-item').filter({has:page.getByRole('heading',{name:'账户余额核验',exact:true})})
    .getByRole('button',{name:'进入评测',exact:true}).click();
  await page.getByRole('combobox',{name:/^执行方式/}).selectOption('dual_runtime');
  const checkbox=page.getByRole('checkbox',{name:/包含冻结留出题/});
  await expect(checkbox).not.toBeChecked();
  const start=page.getByRole('button',{name:'开始测试',exact:true});
  await expect(start).toBeEnabled();
  await checkbox.check();
  await expect(page.getByText('缺少已准入工具：holdout_only_tool',{exact:false})).toBeVisible();
  await expect(start).toBeDisabled();
  allowHoldout=true;
  await checkbox.uncheck();
  await expect(start).toBeEnabled();
  await checkbox.check();
  await expect(start).toBeEnabled();
  await expect(page.getByText('本轮共 2 题，两端使用相同题集。',{exact:true})).toBeVisible();
  for(const width of [1366,390,320]){
    await page.setViewportSize({width,height:900});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await checkbox.scrollIntoViewIfNeeded();
    assert(await page.locator('.holdout-option .case-copy').evaluate(element=>element.getBoundingClientRect().width)>180,
      'Holdout description must not be squeezed into an index column');
    await page.screenshot({path:path.join(output,`holdout-${width}.png`),fullPage:true});
  }
  await start.click();
  await expect(page.getByText('UI_PROBE_EXECUTION_DISABLED',{exact:true})).toBeVisible();
  assert.equal(posted.length,1);
  assert.equal(posted[0].includeHoldout,true);
  assert.equal(posted[0].evaluationMode,'candidate_runtime_comparison');
  await checkbox.uncheck();
  await start.click();
  await expect.poll(()=>posted.length).toBe(2);
  assert.equal(posted[1].includeHoldout,false);
  assert.equal(judge.calls.length,0);
  assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'report.json'),JSON.stringify({status:'PASS',
    scope:'ISOLATED_UI_CONTRACT_NOT_NATIVE_EXECUTION',viewports:[1366,390,320],
    holdoutMetadata:true,holdoutToolsPreflight:true,posted,preflights,errors,
    modelCalls:0,bankCalls:0,realSSO:'NOT_RUN'},null,2));
  console.log(JSON.stringify({status:'PASS',output}));
}finally{
  await browser?.close();await app.close();await judge.close();await rm(root,{recursive:true,force:true});
}
