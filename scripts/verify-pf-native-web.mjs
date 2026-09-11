import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,mkdir,rm,copyFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {once} from 'node:events';
import {chromium} from '@playwright/test';
import {createEvaluationService} from '../dist/service/server.js';

const zip=path.resolve(process.argv[2]),out=path.resolve(process.argv[3]);await mkdir(out,{recursive:true,mode:0o700});
const data=await mkdtemp(path.join(os.tmpdir(),'pf-native-web-')),hostData=path.join(data,'host');await mkdir(hostData,{mode:0o700});
const token=randomBytes(32).toString('hex');await writeFile(path.join(hostData,'access-token'),token,{mode:0o600});
await writeFile(path.join(hostData,'grant.json'),JSON.stringify({active:true,subject:'synthetic-reference-customer',scope:'reference:balance:read',expiresAt:new Date(Date.now()+600000).toISOString()}));
for(const [a,b] of [['reference-ports.json','ports.json'],['reference-fixtures.json','fixtures.json']])await copyFile(path.resolve('examples/migration-native-host',a),path.join(hostData,b));
const socket=net.createServer();socket.listen(0,'127.0.0.1');await once(socket,'listening');const port=socket.address().port;await new Promise(r=>socket.close(r));
const cp=await readFile('examples/migration-native-host/target/classpath.txt','utf8');
const child=spawn('java',['-cp',path.resolve('examples/migration-native-host/target/classes')+path.delimiter+cp.trim(),'NativeMigrationHost'],{env:{...process.env,MIGRATION_HOST_PORT:String(port),MIGRATION_HOST_DATA:hostData},stdio:['ignore','pipe','pipe']});child.stdout.resume();child.stderr.resume();
process.env.FINANCE_MIGRATION_NATIVE_ENDPOINT=`http://127.0.0.1:${port}/execute`;process.env.FINANCE_MIGRATION_NATIVE_TOKEN_FILE=path.join(hostData,'access-token');
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:path.join(data,'workspace'),publicDirectory:path.resolve('web-dist'),accessToken:token,publicDemo:false});
const browser=await chromium.launch({headless:true});const checks=[];let report;
const headers={authorization:'Bearer '+token};
try{
  for(let i=0;i<100;i++){if((await app.inject({url:'/api/migrations/target',headers})).json().available)break;await new Promise(r=>setTimeout(r,100));}
  assert((await app.inject({url:'/api/migrations/target',headers})).json().available);
  assert.equal((await app.inject({url:'/api/migrations/target'})).statusCode,401);checks.push('private_auth_required');
  const address=await app.listen({host:'127.0.0.1',port:0}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(address);await page.getByLabel('访问令牌').fill(token);await page.getByRole('button',{name:'进入工作区',exact:true}).click();
  await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.getByRole('button',{name:'新建迁移',exact:true}).click();await page.locator('input[type=file]').setInputFiles(zip);
  await page.getByRole('button',{name:'选择迁移目标'}).waitFor({timeout:30000});await page.getByRole('button',{name:'选择迁移目标'}).click();
  await page.getByLabel('执行方式').selectOption('pf-method-synthetic-v1');await page.getByRole('checkbox').check();
  await page.getByRole('button',{name:'生成迁移候选',exact:true}).click();await page.getByText('新增 · migration-generated/neutral-contract.json',{exact:true}).waitFor();checks.push('uploaded_pf_diagnosed_generated_reviewed');
  const projects=(await app.inject({url:'/api/migrations',headers})).json(),project=projects[0];assert(project.candidate);
  const early=await app.inject({method:'POST',url:`/api/migrations/${project.id}/verify-target`,headers,payload:{baseAssetId:project.source.assetId}});assert.equal(early.statusCode,409);checks.push('stale_source_cannot_run');
  await page.getByRole('button',{name:'检查验证条件',exact:true}).click();await page.getByRole('button',{name:'运行当前候选'}).click();
  const deadline=Date.now()+550000;
  do{await new Promise(r=>setTimeout(r,1000));report=(await app.inject({url:`/api/migrations/${project.id}/report`,headers})).json();}while((!report.targetRuns?.length||report.targetRuns.at(-1).status==='RUNNING')&&Date.now()<deadline);
  await writeFile(path.join(out,'target-report.json'),JSON.stringify(report,null,2),{mode:0o600});
  assert.equal(report.verification.targetExecution,'PASSED',JSON.stringify(report.targetRuns));checks.push('generated_asset_real_model_native_agent_passed');
  await page.getByRole('heading',{name:/当前候选 · 模拟目标执行通过/}).waitFor({timeout:10000});await page.screenshot({path:path.join(out,'target-desktop.png'),fullPage:true});checks.push('webpage_displays_current_evidence');
  const archiveResponse=await app.inject({url:`/api/migrations/${project.id}/export`,headers});assert.equal(archiveResponse.statusCode,200);await writeFile(path.join(out,'pf-simulated-candidate.zip'),archiveResponse.rawPayload,{mode:0o600});
  await page.reload();await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();await page.locator('.migration-project').filter({hasText:project.name}).click();await page.getByRole('button',{name:'3 目标验证',exact:true}).click();await page.getByRole('heading',{name:/当前候选 · 模拟目标执行通过/}).waitFor();checks.push('refresh_preserves_verified_result');
  await page.setViewportSize({width:390,height:900});assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(out,'target-mobile.png'),fullPage:true});checks.push('mobile_no_overflow');
  const analysis=(await app.inject({method:'POST',url:`/api/migrations/${project.id}/analyze`,headers})).json();
  const edited=await app.inject({method:'POST',url:`/api/migrations/${project.id}/drafts`,headers,payload:{source:analysis.candidate+'\n保留合成数据来源标识。',notes:'验证修改使旧证据失效',baseAssetId:project.candidate.assetId,autoVersion:true}});assert.equal(edited.statusCode,200);
  const after=(await app.inject({url:`/api/migrations/${project.id}/report`,headers})).json();assert.equal(after.verification.targetExecution,'NOT_RUN');checks.push('edit_invalidates_previous_acceptance');
  assert.equal((await app.inject({method:'POST',url:`/api/migrations/${project.id}/verify-target`,headers,payload:{baseAssetId:project.candidate.assetId}})).statusCode,409);checks.push('stale_candidate_after_edit_rejected');
  const previous=process.env.FINANCE_MIGRATION_NATIVE_ENDPOINT;process.env.FINANCE_MIGRATION_NATIVE_ENDPOINT='http://127.0.0.1:1/execute';assert.equal((await app.inject({url:'/api/migrations/target',headers})).json().available,false);process.env.FINANCE_MIGRATION_NATIVE_ENDPOINT=previous;checks.push('offline_target_not_ready');
  assert.deepEqual(errors,[]);checks.push('no_browser_errors');
}finally{
  await writeFile(path.join(out,'checks.json'),JSON.stringify({checks,mode:'PF_METHOD_REAL_MODEL_SYNTHETIC_PORTS',originalNativeEquivalent:false,professionalAcceptance:'NOT_RUN',deployed:false},null,2),{mode:0o600});
  await browser.close();await app.close();child.kill('SIGTERM');if(child.exitCode===null)await once(child,'exit');await rm(data,{recursive:true,force:true});
}
console.log(JSON.stringify({checks,originalNativeEquivalent:false}));
