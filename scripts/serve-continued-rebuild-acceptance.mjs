/** Continue an idle real Builder fixture without rebuilding or rewriting evidence. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,cp} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {createEvaluationService} from '../dist/service/server.js';
const root=process.cwd(),git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
assert(!git('status','--porcelain'),'Commit before continued acceptance');
assert(process.env.CLOSEOUT_REBUILD_WORK,'Explicit real Builder fixture owner required');
const owner=path.resolve(process.env.CLOSEOUT_REBUILD_WORK),prior=JSON.parse(await readFile(path.join(owner,'service.json'),'utf8'));
assert(prior.launcherBackend==='NATIVE_PACKAGE'&&prior.provenance==='CONTINUED_REAL_GENERATED_CANDIDATE');
assert(path.resolve(prior.data)===path.join(owner,'data')&&path.resolve(prior.state)===path.join(owner,'builder'));
const parentWork=process.env.CLOSEOUT_REBUILD_DATA_WORK?path.resolve(process.env.CLOSEOUT_REBUILD_DATA_WORK):owner;
const parent=parentWork===owner?prior:JSON.parse(await readFile(path.join(parentWork,'service.json'),'utf8'));
assert(path.resolve(parent.data)===path.join(parentWork,'data')&&parent.state===prior.state&&parent.candidateDigest===prior.candidateDigest);
assert(parentWork===owner||parent.builderStateOwner===owner,'Data parent must belong to the same Builder fixture');
const releasePort=Number(process.env.CLOSEOUT_RELEASE_PORT);
assert(Number.isInteger(releasePort)&&releasePort>0&&releasePort<=65535,'Explicit observed Builder release port required');
const baseline=JSON.parse(await readFile(path.join(prior.state,'baseline-connection-info.json'),'utf8'));
const probe=await fetch(new URL('v1/runtime-capabilities',baseline.baseUrl),{headers:{Authorization:`Bearer ${baseline.token}`}});
assert(probe.ok,'Existing real Builder owner is unavailable');
process.env.REBUILD_UI_BASELINE_TOKEN=baseline.token;
const trust=[{reference:'rebuild-baseline',label:'受限基线部署',baseUrlPrefix:baseline.baseUrl,credentialEnv:'REBUILD_UI_BASELINE_TOKEN'},
 {reference:'rebuild-release',label:'Builder 新部署',baseUrlPrefix:`http://127.0.0.1:${releasePort}/oj/`,credentialEnv:'REBUILD_UI_RELEASE_TOKEN'}];
const work=await mkdtemp(path.join(os.tmpdir(),'continued-rebuild-ui-')),data=path.join(work,'data');
await cp(parent.data,data,{recursive:true,errorOnExist:true});
const project=JSON.parse(await readFile(path.join(data,'migrations',`${prior.projectId}.json`),'utf8'));
assert(project.candidate?.artifactSha256===prior.candidateDigest,'Candidate provenance must remain unchanged');
assert(!project.improvementTasks?.some(task=>['RUNNING','WAITING_BUILDER','WAITING_CONFIGURATION'].includes(task.status)),'Data parent must be idle');
for(const suffix of ['PROVIDER','BASE_URL','API_KEY','MODEL','REQUEST_DEFAULTS','TIMEOUT_MS']){
 const value=process.env[`FINANCE_EVAL_ANALYZER_${suffix}`];if(value!==undefined)process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`]=value;
}
process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS='1';
const app=await createEvaluationService({rootDirectory:root,dataDirectory:data,publicDirectory:path.join(root,'web-dist'),publicDemo:false,accessToken:'runtime-rebuild-ui',launcherTrust:trust});
app.log.level='error';const url=await app.listen({host:'127.0.0.1',port:0});
await writeFile(path.join(work,'service.json'),JSON.stringify({...prior,url,work,data,eval:git('rev-parse','HEAD'),parentEval:parent.eval,parentWork,
 builderStateOwner:owner,state:prior.state,provenance:'CONTINUED_REAL_BUILDER_UI_DATA',releasePort},null,2));
console.log(JSON.stringify({url,work,status:'READY_FOR_CONTINUED_UI'}));
let closed=false,releaseReady=false;async function close(){if(closed)return;closed=true;await app.close()}
process.once('SIGINT',()=>void close());process.once('SIGTERM',()=>void close());
while(!closed){
 if(!releaseReady)try{const release=JSON.parse(await readFile(path.join(prior.state,'connection-info.json'),'utf8'));
   assert.equal(release.baseUrl,`http://127.0.0.1:${releasePort}/oj/`);
   process.env.REBUILD_UI_RELEASE_TOKEN=release.token;releaseReady=true;console.log('READY: import the actual Builder Result through the UI');
 }catch(error){if(error.code!=='ENOENT')throw error}
 try{await readFile(path.join(work,'stop'));await close()}catch(error){if(error.code!=='ENOENT')throw error}
 await new Promise(resolve=>setTimeout(resolve,500));
}
