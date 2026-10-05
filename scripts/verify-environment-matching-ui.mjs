/** Synthetic catalog only: verifies UI selection, not native execution or SSO. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';
const out=path.resolve(process.argv[2]);await mkdir(out,{recursive:true});
const web=path.resolve('web-dist');
const model={providerId:'fixture',modelId:'synthetic-model',upstreamModelId:'synthetic-model',availability:'ready',parameters:{}};
const roles=Object.fromEntries(['execution','judge','analyzer','optimizer','directExecution'].map(name=>[name,{configured:true,model}]));
const caps=(family,names,min)=>({runtime:{type:family,version:'fixture-only'},models:[model],defaultModelId:model.modelId,
  nativeToolNames:names,auxiliaryToolNames:['read_case_file'],features:{externalMcp:false},limits:{minPrimaryTools:min}});
const environments=[];
for(const [profile,tools,min] of [['account',['balance','read_case_file'],1],['review',['audit'],1],['plain',[],0]]){
  for(const family of ['openjiuwen','agentscope']){
    const id=`${profile}-${family}`,inspection={status:'ready',error:null,elapsedMs:1,toolCount:tools.length,
      tools:tools.map(name=>({name})),mcpServers:[],capabilities:caps(family,tools,min)};
    environments.push({runtimeId:id,launcherEnvironmentId:id,name:`${profile} · ${family}`,runtimeType:family,
      defaultModelId:model.modelId,models:[model],toolCount:tools.length,mcpEnvironmentIds:[],inspection});
  }
}
const fixtures=[['bank','账户核验',['balance','read_case_file']],['audit','材料核验',['audit']],['plain','纯文本方法',[]],['missing','缺失工具方法',['unavailable_tool']]];
const packs=fixtures.map(([id,title,tools])=>({packId:id,version:'1',targetSkillId:id,targetSkillVersion:'1',description:title,
  cases:[{caseId:id+'-case',name:title,prompt:title,requiredTools:tools}],caseCount:1,holdoutCaseCount:0,
  models:{execution:{left:model,right:model}},variants:{left:{mode:'without_target_skill',skillId:id},
    right:{mode:'skill_version',skillId:id,version:'1',artifactSha256:id.repeat(32).slice(0,64)}},replayReady:false}));
const assets=fixtures.map(([id,title,tools])=>({assetId:id+'-asset',skillId:id,version:'1',displayName:title,
  artifactSha256:id.repeat(32).slice(0,64),runtimeRequirements:{status:'declared',tools}}));
const catalog={publicDemo:false,serviceVersion:'fixture',modelRoles:roles,environments:[],preparations:[],
  executionRuntimes:environments,uploadedSkills:assets,evalPacks:packs,runtimes:[],
  featuredSkills:fixtures.map(([id,title,tools])=>({skillId:id,displayName:title,roleName:title,category:'synthetic',summary:'合成浏览器测试',
    iconKey:'wealth',capabilities:[],requiredTools:tools,taskCount:1,evaluationStatus:'ready',
    versions:[{version:'1',packId:id,artifactSha256:assets.find(a=>a.skillId===id).artifactSha256}]}))};
const server=createServer(async(req,res)=>{
  try{
    const pathname=new URL(req.url,'http://localhost').pathname;
    const file=path.resolve(web,'.'+(pathname==='/'?'/index.html':pathname));
    assert(file.startsWith(web+path.sep));
    res.setHeader('content-type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html');
    res.end(await readFile(file));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const report={status:'FAIL',scope:'CONTROLLED_UI_ONLY',realModel:false,genuineSso:false,views:[],errors:[],capturedRuns:[]};
let browser,page;
try{
  browser=await chromium.launch({headless:true});
  page=await browser.newPage({viewport:{width:1366,height:960}});
  page.on('pageerror',e=>report.errors.push(e.message));
  await page.route('**/api/**',async route=>{
    const pathname=new URL(route.request().url()).pathname;
    let response;
    if(pathname==='/api/catalog')response=catalog;
    else if(pathname==='/api/runs'&&route.request().method()==='POST'){
      report.capturedRuns.push(route.request().postDataJSON());
      await route.fulfill({status:409,json:{message:'CONTROLLED_CAPTURE_ONLY'}});return;
    }
    else if(pathname==='/api/runs')response={runs:[]};
    else if(pathname.endsWith('/preflight'))response=environments.find(e=>pathname.includes(e.runtimeId))?.inspection;
    else throw Error('Unexpected API '+pathname);
    await route.fulfill({json:response});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`,{waitUntil:'networkidle'});
  async function open(title){
    await page.getByRole('button',{name:'精选技能',exact:true}).click();
    await page.locator('.skill-list-item').filter({has:page.getByRole('heading',{name:title,exact:true})}).getByRole('button',{name:'进入评测',exact:true}).click();
  }
  await open('账户核验');
  await expect(page.getByLabel('执行环境',{exact:true})).toHaveValue('account-openjiuwen');
  await page.getByRole('button',{name:'对比 Runtime',exact:true}).click();
  await expect(page.getByLabel('对照组 Runtime',{exact:true})).toHaveValue('account-openjiuwen');
  await expect(page.getByLabel('目标组 Runtime',{exact:true})).toHaveValue('account-agentscope');
  await expect(page.getByRole('button',{name:'开始测试',exact:true})).toBeEnabled();
  for(const width of [1366,390,320]){
    await page.setViewportSize({width,height:960});
    await page.evaluate(()=>window.scrollTo(0,0));
    const actual=await page.evaluate(()=>Math.max(document.body.scrollWidth,document.documentElement.scrollWidth));
    assert(actual<=width,`OVERFLOW_${width}_${actual}`);report.views.push({width,actual});
    await page.screenshot({path:path.join(out,`comparison-${width}.png`),fullPage:true});
  }
  await page.setViewportSize({width:1366,height:960});
  await page.getByRole('button',{name:'开始测试',exact:true}).click();
  await expect.poll(()=>report.capturedRuns.length).toBe(1);
  assert.equal(report.capturedRuns[0].runtimeBindings.left.environmentId,'account-openjiuwen');
  assert.equal(report.capturedRuns[0].runtimeBindings.right.environmentId,'account-agentscope');
  assert.equal(report.capturedRuns[0].runtimeBindings.left.skillAssetId,report.capturedRuns[0].runtimeBindings.right.skillAssetId);
  await page.getByRole('button',{name:'对比模型',exact:true}).click();
  await expect(page.getByText('当前环境只有一个可用模型，暂无第二个模型可比较。')).toBeVisible();
  await expect(page.getByRole('button',{name:'开始测试',exact:true})).toBeDisabled();
  await open('材料核验');
  await expect(page.getByLabel('执行环境',{exact:true})).toHaveValue('review-openjiuwen');
  await page.getByRole('button',{name:'对比 Runtime',exact:true}).click();
  await expect(page.getByLabel('目标组 Runtime',{exact:true})).toHaveValue('review-agentscope');
  await open('纯文本方法');
  await expect(page.getByLabel('执行环境',{exact:true})).toHaveValue('plain-openjiuwen');
  await page.getByLabel('运行框架',{exact:true}).selectOption('agentscope');
  await expect(page.getByLabel('执行环境',{exact:true})).toHaveValue('plain-agentscope');
  await open('缺失工具方法');
  await expect(page.getByLabel('执行环境',{exact:true})).toHaveValue('');
  await expect(page.getByRole('button',{name:'开始测试',exact:true})).toBeDisabled();
  await page.getByText('工具依赖与未匹配原因',{exact:true}).click();
  await expect(page.locator('.environment-details')).toContainText('缺少已准入工具：unavailable_tool');
  assert.deepEqual(report.errors,[]);report.status='PASS';
}catch(e){report.error=e.message;report.pageText=await page?.locator('body').innerText();await page?.screenshot({path:path.join(out,'failure.png'),fullPage:true});process.exitCode=1;}
finally{
  await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2));
}
console.log(JSON.stringify(report));
