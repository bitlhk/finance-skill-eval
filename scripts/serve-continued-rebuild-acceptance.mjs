/** Reload Eval against its existing owned Builder fixture; never reconstruct verdicts. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile,mkdtemp,cp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createEvaluationService} from '../dist/service/server.js';
import {EnvironmentStore} from '../dist/service/environment-store.js';
const root=process.cwd(),git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
assert(!git('status','--porcelain'),'Commit implementation before pinned acceptance');
assert(process.env.CLOSEOUT_REBUILD_OWNER&&process.env.CLOSEOUT_REBUILD_RELEASE_PORT,'Explicit owned Builder host and its reserved release port required');
const owner=path.resolve(process.env.CLOSEOUT_REBUILD_OWNER),prior=JSON.parse(await readFile(path.join(owner,'service.json'),'utf8'));
assert(prior.launcherBackend==='NATIVE_PACKAGE'&&path.resolve(prior.state)===path.join(owner,'builder'));
const port=Number(process.env.CLOSEOUT_REBUILD_RELEASE_PORT);assert(Number.isInteger(port)&&port>0&&port<65536);
const baseline=JSON.parse(await readFile(path.join(prior.state,'baseline-connection-info.json'),'utf8'));
process.env.REBUILD_UI_BASELINE_TOKEN=baseline.token;
const trust=[{reference:'rebuild-baseline',label:'受限基线部署',baseUrlPrefix:baseline.baseUrl,credentialEnv:'REBUILD_UI_BASELINE_TOKEN'},
 {reference:'rebuild-release',label:'Builder 新部署',baseUrlPrefix:`http://127.0.0.1:${port}/oj/`,credentialEnv:'REBUILD_UI_RELEASE_TOKEN'}];
const work=await mkdtemp(path.join(os.tmpdir(),'continued-rebuild-ui-')),data=path.join(work,'data');
await cp(prior.data,data,{recursive:true,errorOnExist:true});
const environments=new EnvironmentStore(data,trust);await environments.initialize();
const saved=await environments.get(prior.baselineEnvironmentId);
const actual=JSON.parse(await readFile(path.join(prior.state,'baseline-result.json'),'utf8'));
assert.equal(saved.baseUrl,baseline.baseUrl);assert.equal(saved.delivery?.artifactSha256,actual.artifactSha256);
// Live probing uses the real private connection, not copied capabilities assertions.
const response=await fetch(new URL('v1/runtime-capabilities',baseline.baseUrl),{headers:{Authorization:`Bearer ${baseline.token}`}});
assert(response.ok,'Existing Builder owner is unavailable');
for(const suffix of ['PROVIDER','BASE_URL','API_KEY','MODEL','REQUEST_DEFAULTS','TIMEOUT_MS']){
 const value=process.env[`FINANCE_EVAL_ANALYZER_${suffix}`];if(value!==undefined)process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`]=value;
}
process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS='1';process.env.FINANCE_EVAL_AGENT_DUMP=path.join(work,'agent-logs');
const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,publicDirectory:path.join(root,'web-dist'),
 publicDemo:false,accessToken:'runtime-rebuild-ui',launcherTrust:trust});app.log.level='error';
const url=await app.listen({host:'127.0.0.1',port:0});
await writeFile(path.join(work,'service.json'),JSON.stringify({...prior,url,work,data,eval:git('rev-parse','HEAD'),owner,
 provenance:'CONTINUED_REAL_BUILDER_OWNER'},null,2));
console.log(JSON.stringify({url,work,status:'READY_FOR_UI'}));
let closed=false,releaseReady=false;async function close(){if(closed)return;closed=true;await app.close()}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
while(!closed){
 if(!releaseReady)try{const release=JSON.parse(await readFile(path.join(prior.state,'connection-info.json'),'utf8'));
  assert.equal(release.baseUrl,`http://127.0.0.1:${port}/oj/`);process.env.REBUILD_UI_RELEASE_TOKEN=release.token;releaseReady=true;
  console.log('READY: import the actual Builder Result through the UI');
 }catch(error){if(error.code!=='ENOENT')throw error}
 try{await readFile(path.join(work,'stop'));await close()}catch(error){if(error.code!=='ENOENT')throw error}
 await new Promise(resolve=>setTimeout(resolve,500));
}
