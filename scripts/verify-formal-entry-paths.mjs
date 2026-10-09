/** Root-built UI with real read-only history, through a synthetic local ingress.
 * This does not verify Linggan SSO, promote a release, or execute an evaluation.
 */
import assert from 'node:assert/strict';
import {createServer, request as httpRequest} from 'node:http';
import {mkdir,readFile,writeFile,lstat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {chromium,expect} from '@playwright/test';

const [web,out,upstreamUrl,credentialFile,subject,jobId]=process.argv.slice(2);
assert(web&&out&&credentialFile,'Expected web output, evidence directory, origin, credential file, subject, run ID');
const origin=new URL(upstreamUrl);
assert.equal(origin.protocol,'http:');assert.equal(origin.hostname,'127.0.0.1');
assert.equal(origin.pathname,'/');assert(!origin.username&&!origin.password&&!origin.search&&!origin.hash);
assert(/^studio_[A-Za-z0-9_-]{1,120}$/.test(subject));assert(/^run-[a-f0-9-]+$/.test(jobId));
const webRoot=path.resolve(web),index=await readFile(path.join(webRoot,'index.html'));
assert(!index.toString().includes('/release-check/'),'ROOT_BUILD_REQUIRED');
assert(index.toString().includes('src="/assets/'),'ROOT_ASSET_PREFIX_REQUIRED');
const mode=await lstat(credentialFile);
assert(mode.isFile()&&!mode.isSymbolicLink()&&!(mode.mode&0o077),'PRIVATE_INGRESS_FILE_REQUIRED');
const token=(await readFile(credentialFile,'utf8')).trim();assert(token.length>=32);
await mkdir(out,{mode:0o700});
const headers={authorization:'Bearer '+token,'x-demo-user':subject,
  origin:'https://finance-eval.demo.linggan.top'};
async function getJob(){
  const response=await fetch(new URL('/api/runs/'+jobId,origin),{headers});
  assert.equal(response.status,200);return response.json();
}
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const before=await getJob();assert.equal(before.status,'completed');
const requests=[],blocked=[],assets=[],errors=[],children=new Set();
const allowed=new Set(['/api/catalog','/api/runs',`/api/runs/${jobId}`,
  `/api/runs/${jobId}/optimization`,`/api/runs/${jobId}/export`]);
const proxy=createServer(async(req,res)=>{
  try{
    const url=new URL(req.url,'http://local'),route=url.pathname;
    if(!['GET','HEAD'].includes(req.method)){
      blocked.push({method:req.method,path:route});res.writeHead(405);res.end();return;
    }
    if(route.startsWith('/api/')){
      assert(allowed.has(route),'UNEXPECTED_API_PATH');requests.push({method:req.method,path:route});
      // Never pass a browser-provided token, subject or cookie to the real service.
      const upstream=httpRequest(new URL(req.url,origin),{method:req.method,headers},reply=>{
        res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);
      });
      children.add(upstream);upstream.on('close',()=>children.delete(upstream));
      upstream.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});
      res.on('close',()=>upstream.destroy());upstream.end();return;
    }
    const target=path.resolve(webRoot,'.'+decodeURIComponent(route==='/'?'/index.html':route));
    assert(target.startsWith(webRoot+path.sep),'STATIC_PATH_ESCAPE');
    const stat=await lstat(target);assert(stat.isFile()&&!stat.isSymbolicLink(),'STATIC_FILE_REQUIRED');
    const type={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml',
      '.png':'image/png','.ico':'image/x-icon'}[path.extname(target)]??'application/octet-stream';
    assets.push(route);res.writeHead(200,{'content-type':type,'cache-control':'no-store'});
    res.end(await readFile(target));
  }catch{res.writeHead(404);res.end();}
});
await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
const report={status:'FAIL',scope:'ROOT_STATIC_AND_READ_ONLY_REAL_HISTORY_SYNTHETIC_INGRESS',
  genuineSsoVerified:false,rootSwitched:false,jobId,views:[],requests,blocked,assets,errors};
let browser;
try{
  browser=await chromium.launch({headless:true});
  const page=await browser.newPage({viewport:{width:1366,height:900},acceptDownloads:true});
  // Existing root visitors may retain an obsolete local token. Trusted ingress must replace it.
  await page.addInitScript(()=>localStorage.setItem('finance-eval-token','obsolete-public-demo-token'));
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{
    if(response.status()>=400&&response.request().method()==='GET')errors.push(new URL(response.url()).pathname+':'+response.status());
  });
  const listing=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/runs'&&r.request().method()==='GET');
  await page.goto(`http://127.0.0.1:${proxy.address().port}/`,{waitUntil:'networkidle'});
  const runs=(await (await listing).json()).runs;
  const position=runs.findIndex(row=>row.jobId===jobId);assert(position>=0);
  await expect(page.getByRole('heading',{name:'私有工作区',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'运行记录',exact:true}).click();
  await expect(page.locator('.history-item')).toHaveCount(runs.length);
  await page.locator('.history-item').nth(position).click();
  await expect(page.getByText(jobId,{exact:true})).toBeVisible();
  for(const width of [1366,390,320]){
    await page.setViewportSize({width,height:900});
    const scrollWidth=await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth));
    assert(scrollWidth<=width,'HORIZONTAL_OVERFLOW');report.views.push({width,scrollWidth});
    await page.screenshot({path:path.join(out,`root-history-${width}.png`),fullPage:true});
    await page.evaluate(()=>window.scrollTo(0,0));
    await page.screenshot({path:path.join(out,`root-viewport-${width}.png`)});
  }
  await page.setViewportSize({width:1366,height:900});
  const download=page.waitForEvent('download');
  await page.locator('.report-downloads').getByRole('button',{name:'JSON',exact:true}).click();
  const file=await download;assert.equal(await file.failure(),null);
  assert.equal(file.suggestedFilename(),`${jobId}.json`);
  const exported=await readFile(await file.path());JSON.parse(exported);
  report.download={filename:file.suggestedFilename(),bytes:exported.length,
    sha256:createHash('sha256').update(exported).digest('hex')};
  assert(blocked.every(row=>row.method==='POST'&&/^\/api\/environments\/env-[a-z0-9-]+\/preflight$/.test(row.path)));
  assert(assets.some(name=>name.startsWith('/assets/')&&name.endsWith('.js')));
  assert([...assets,...requests.map(row=>row.path)].every(name=>!name.startsWith('/release-check')));
  assert.deepEqual(errors,[]);assert.equal(hash(await getJob()),hash(before));
  Object.assign(report,{status:'PASS',sourceJobSha256:hash(before),sourceUnchanged:true,
    businessWriteRequestsForwarded:0,obsoleteBrowserTokenIgnored:true});
}catch(error){report.error=error.message;process.exitCode=1;}
finally{
  await browser?.close();for(const child of children)child.destroy();proxy.closeAllConnections();
  await new Promise(resolve=>proxy.close(resolve));
  report.cleanup=true;
  await writeFile(path.join(out,'report.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
}
console.log(JSON.stringify(report));
