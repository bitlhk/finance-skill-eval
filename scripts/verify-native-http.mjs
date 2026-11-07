// Exercise the production entry over real HTTP with a separate data directory.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {createServer as createGateway,request as proxyRequest} from 'node:http';
import {mkdtemp,writeFile} from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {zipSync} from 'fflate';

const directory=await mkdtemp(path.resolve('artifacts/native-http-'));
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const token='isolated-native-verification';
const child=spawn(process.execPath,['--env-file-if-exists=.env.local','scripts/serve-api.mjs'],{
  env:{...process.env,FINANCE_EVAL_PORT:String(port),FINANCE_EVAL_HOST:'127.0.0.1',FINANCE_EVAL_DATA_DIR:directory,
    FINANCE_EVAL_PUBLIC_DIR:path.resolve(process.env.MIGRATION_TEST_WEB_DIR||'web-dist'),
    FINANCE_EVAL_ACCESS_TOKEN:token,FINANCE_EVAL_WORKSPACE_MODE:'single',FINANCE_EVAL_WORKSPACE_SUBJECT:'',FINANCE_EVAL_PUBLIC_DEMO:'false'},
  windowsHide:true,stdio:['pipe','pipe','pipe']});
const logFile=createWriteStream(path.join(directory,'server.log'));
for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>logFile.write(chunk));
const url=`http://127.0.0.1:${port}`,headers={authorization:'Bearer '+token};
async function api(route,body,options={}){
  const response=await fetch(url+route,{headers:{...headers,...(body?{'content-type':Buffer.isBuffer(body)?'application/zip':'application/json'}:{}),...options.headers},
    method:body?'POST':'GET',...(body?{body:Buffer.isBuffer(body)?body:JSON.stringify(body)}:{}),...options,signal:AbortSignal.timeout(30000)});
  assert(response.ok,route+' HTTP '+response.status+' '+(response.ok?'':await response.text()));
  return response;
}
const checks=[];
const originalPush=checks.push.bind(checks);
checks.push=value=>{console.log(JSON.stringify({passed:value}));return originalPush(value);};
const passed=value=>checks.push(value);
await writeFile(path.join(directory,'connection.json'),JSON.stringify({url,pid:child.pid}));
try{
  for(let attempts=0;;attempts++){
    if(child.exitCode!==null)throw Error('Native service stopped before readiness');
    try{if((await fetch(url+'/api/health')).ok)break;}catch{}
    if(attempts>300)throw Error('Native service did not become ready');
    await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert.equal((await fetch(url+'/api/catalog')).status,401);
  const catalog=await (await api('/api/catalog')).json();passed('authentication/catalog');
  const pack=catalog.evalPacks.find(pack=>pack.replayReady&&pack.deterministicReady);
  assert(pack,'Replay pack missing');
  let job=await (await api('/api/runs',{packId:pack.packId,runtime:{type:'replay'},judgeMode:'deterministic'})).json();
  for(let attempts=0;!['completed','failed','cancelled','interrupted'].includes(job.status);attempts++){
    if(attempts>400)throw Error('Fixed comparison did not settle');
    await new Promise(resolve=>setTimeout(resolve,100));job=await (await api('/api/runs/'+job.jobId)).json();
  }
  assert.equal(job.status,'completed',JSON.stringify(job.error));passed('comparison/report');
  const controller=new AbortController();
  const events=await fetch(url+'/api/runs/'+job.jobId+'/events',{headers,signal:controller.signal});
  const reader=events.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/event: job/);
  await reader.cancel();controller.abort();checks.push('HTTP/SSE');
  const original=job.report.reportFingerprint;
  await api('/api/runs/'+job.jobId+'/rescore',{repetitions:2});
  assert.equal((await (await api('/api/runs/'+job.jobId)).json()).report.reportFingerprint,original);checks.push('frozen-evidence/rescore');
  for(const format of ['md','html','json'])assert((await (await api('/api/runs/'+job.jobId+'/export?format='+format)).text()).length>100);
  checks.push('report/exports');
  const review=await (await api('/api/evaluation-reviews?kind=comparison&id='+job.jobId)).json();
  assert(review.targets.length);checks.push('human-review/calibration');
  const archive=Buffer.from(zipSync({'nested/SKILL.md':Buffer.from('---\nname: http-check\ndescription: native\n---\nPreserve existing business rules')}));
  const asset=await (await api('/api/migration-tasks/assets',archive)).json();
  const task=await (await api('/api/migration-tasks',{sourceAssetIds:[asset.assetId],goal:'Preserve business rules'})).json();
  assert(task.id);assert.equal((await (await api('/api/migration-tasks/'+task.id)).json()).id,task.id);checks.push('migration/assets/Git/persistence');
  const project=Buffer.from(zipSync({'source/agent.py':Buffer.from('print("complete project")')}));
  const projectResponse=await api('/api/migration-tasks/upload?inputKind=agent_project',project);
  const projectResult=await projectResponse.json();assert(projectResult.id??projectResult.source);checks.push('full-agent-project/upload');
  if(process.argv.includes('--ui')){
    const {chromium,expect}=await import('@playwright/test');
    const installed=process.platform==='win32'?['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync):undefined;
    const browser=await chromium.launch({headless:true,...(installed?{executablePath:installed}:{})});
    const prefix=process.env.MIGRATION_TEST_PREFIX||'';
    let gateway;
    let browserUrl=url;
    if(prefix){
      gateway=createGateway((incoming,outgoing)=>{
        const forwarded={...incoming.headers};
        if(forwarded['x-migration-authorization'])forwarded.authorization=forwarded['x-migration-authorization'];
        delete forwarded['x-migration-authorization'];
        const request=proxyRequest(url+(incoming.url.startsWith(prefix)?incoming.url.slice(prefix.length)||'/':incoming.url),
          {method:incoming.method,headers:forwarded},response=>{outgoing.writeHead(response.statusCode,response.headers);response.pipe(outgoing);});
        request.on('error',()=>outgoing.writeHead(502).end());incoming.pipe(request);
      });
      gateway.listen(0,'127.0.0.1');await once(gateway,'listening');
      browserUrl='http://127.0.0.1:'+gateway.address().port+prefix+'/';
    }
    try{
      const context=await browser.newContext({viewport:{width:1440,height:960}});
      await context.addInitScript(({token,prefix})=>localStorage.setItem(prefix?'finance-eval-token:'+prefix+'/':'finance-eval-token',token),{token,prefix});
      const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.goto(browserUrl,{waitUntil:'domcontentloaded'});
      await expect(page.getByRole('button',{name:'Skill 迁移',exact:true})).toBeVisible();
      await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
      await expect(page.getByText(task.name,{exact:true}).first()).toBeVisible();
      await page.screenshot({path:path.join(directory,'migration-ui.png'),fullPage:true});
      await page.getByRole('button',{name:'对比评测',exact:true}).click();
      await page.screenshot({path:path.join(directory,'comparison-ui.png'),fullPage:true});
      assert.deepEqual(errors,[],'Existing UI raised JavaScript errors');passed('existing-theme/migration-and-comparison-UI');
    }finally{await browser.close();if(gateway)await new Promise(resolve=>gateway.close(resolve));}
  }
  await writeFile(path.join(directory,'verification.json'),JSON.stringify({url,checks,jobId:job.jobId,taskId:task.id},null,2));
  console.log(JSON.stringify({passed:true,url,checks,evidence:directory}));
}finally{
  child.stdin.end('stop\n');
  const timeout=setTimeout(()=>child.kill(),45000);
  if(child.exitCode===null)await once(child,'close');clearTimeout(timeout);
  logFile.end();
}
