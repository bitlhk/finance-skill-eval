/** Manual UI acceptance host: real construction, no source/plan/verdict rewrites. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {pinnedBuilderSource} from './lib/pinned-builder-source.mjs';
import {createEvaluationService} from '../dist/service/server.js';
import {EnvironmentStore} from '../dist/service/environment-store.js';
import {MigrationProjectRepository} from '../dist/migration/infrastructure/migration-project-repository.js';
import {configuredModelRole} from '../dist/service/config.js';

const root=process.cwd(),git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
assert(!git('status','--porcelain'),'Commit implementation before pinned acceptance');
const original=process.env.CLOSEOUT_REBUILD_DATA,projectId=process.env.CLOSEOUT_REBUILD_PROJECT;
const builderCommit=process.env.CLOSEOUT_BUILDER_COMMIT,codex=process.env.CLOSEOUT_CODEX_BIN;
assert(original&&projectId&&builderCommit&&codex,'Explicit real candidate data, project, Builder commit and Codex executable required');
const work=await mkdtemp(path.join(os.tmpdir(),'runtime-rebuild-ui-')),data=path.join(work,'data');
await cp(path.resolve(original),data,{recursive:true,errorOnExist:true});
const projects=new MigrationProjectRepository(data),project=await projects.get(projectId);
assert(project.candidate&&project.reuseProposal?.approvedAt,'A genuinely generated candidate and confirmed design are required');
assert(!project.improvementTasks?.some(t=>['RUNNING','WAITING_BUILDER','WAITING_CONFIGURATION'].includes(t.status)),'Use a candidate without an active task');
// Keep original source, diagnosis, design, candidate and prior evidence byte-for-byte.
// The baseline defect is only in the separately delivered native Harness artifact.
const builder=process.env.CLOSEOUT_BUILDER_ROOT??path.resolve(root,'../agent-store-builder-dev-wo-fork/community/finance/builder/finance-solution-builder');
const pinned=await pinnedBuilderSource({project:builder,commit:builderCommit,destination:work});
const sourceFile=path.join(work,'candidate-source.json');
await writeFile(sourceFile,JSON.stringify({assetId:project.candidate.assetId,artifactSha256:project.candidate.artifactSha256}));
const cfg=JSON.parse(await readFile(path.join(root,'.runtime.local.json'),'utf8'));
const model=Object.values(cfg.models).find(m=>m.enabled!==false);assert(model?.apiKey&&model?.baseUrl&&model?.upstreamModelId);
for(const suffix of ['PROVIDER','BASE_URL','API_KEY','MODEL','REQUEST_DEFAULTS','TIMEOUT_MS']){
 const value=process.env[`FINANCE_EVAL_ANALYZER_${suffix}`];if(value!==undefined)process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`]=value;
}
for(const role of ['ANALYZER','MIGRATION','JUDGE','OPTIMIZER'])assert(configuredModelRole(role).adapter,`Missing real ${role}`);
process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS='1';process.env.FINANCE_EVAL_AGENT_DUMP=path.join(work,'agent-logs');
const freePort=async()=>{const s=net.createServer();await new Promise(r=>s.listen(0,'127.0.0.1',r));const p=s.address().port;await new Promise(r=>s.close(r));return p;};
const state=path.join(work,'builder'),baselinePort=await freePort(),releasePort=await freePort();
const child=spawn(process.env.CLOSEOUT_BUILDER_PYTHON??path.join(builder,'../.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),
 ['-B','engineering/verify_eval_runtime_construction.py','--state-root',state,'--python',process.env.CLOSEOUT_PACKAGE_PYTHON??'C:/fb-pkg-py317/Scripts/python.exe',
  '--codex',codex,'--input-rate','0','--output-rate','0','--model-base',model.baseUrl,'--model-name',model.upstreamModelId,
  '--model-key-env','CLOSEOUT_RUNTIME_MODEL_KEY','--await-eval-request','--source-file',sourceFile,
  '--baseline-port',String(baselinePort),'--release-port',String(releasePort),'--serve'],
 {cwd:pinned,windowsHide:true,env:{...process.env,PYTHONUTF8:'1',CLOSEOUT_RUNTIME_MODEL_KEY:model.apiKey},stdio:['ignore','pipe','pipe']});
let stdout='',stderr='';
child.stdout.on('data',b=>{stdout=(stdout+b).slice(-200000)});
child.stderr.on('data',b=>{stderr=(stderr+b).slice(-200000)});
let app,closed=false;
async function shutdown(){if(closed)return;closed=true;await app?.close();await mkdir(state,{recursive:true});await writeFile(path.join(state,'stop'),'stop');
 await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill();resolve()},15000);child.once('exit',()=>{clearTimeout(timer);resolve()})});}
try{
 let baseline;for(let i=0;i<1200;i++){assert.equal(child.exitCode,null,'Baseline construction fixture stopped');
  try{baseline=JSON.parse(await readFile(path.join(state,'baseline-connection-info.json'),'utf8'));break}catch{}
  await new Promise(r=>setTimeout(r,500));}
 assert(baseline,'Baseline did not become ready');process.env.REBUILD_UI_BASELINE_TOKEN=baseline.token;
 const trust=[{reference:'rebuild-baseline',label:'受限基线部署',baseUrlPrefix:baseline.baseUrl,credentialEnv:'REBUILD_UI_BASELINE_TOKEN'},
  {reference:'rebuild-release',label:'Builder 新部署',baseUrlPrefix:`http://127.0.0.1:${releasePort}/oj/`,credentialEnv:'REBUILD_UI_RELEASE_TOKEN'}];
 const environments=new EnvironmentStore(data,trust);await environments.initialize();
 const accepted=await environments.acceptBuilderDelivery({requirements:JSON.parse(await readFile(path.join(state,'baseline-requirements.json'),'utf8')),
  result:JSON.parse(await readFile(path.join(state,'baseline-result.json'),'utf8')),trustReference:'rebuild-baseline',name:'Harness 重建验收基线（两次迭代）'});
 // Old connections may be unavailable; archive only this disposable registry copy.
 for(const e of await environments.list())if(e.environmentId!==accepted.environment.environmentId)await environments.setArchived(e.environmentId,{archived:true});
 app=await createEvaluationService({rootDirectory:root,dataDirectory:data,publicDirectory:path.join(root,'web-dist'),publicDemo:false,
  accessToken:'runtime-rebuild-ui',launcherTrust:trust});app.log.level='error';
 const url=await app.listen({host:'127.0.0.1',port:0});
 const metadata={url,work,data,state,projectId,eval:git('rev-parse','HEAD'),builder:builderCommit,
  provenance:'CONTINUED_REAL_GENERATED_CANDIDATE',sourceUnchanged:true,candidateDigest:project.candidate.artifactSha256,
  launcherBackend:'NATIVE_PACKAGE',javaHarnessExecuted:false,baselineEnvironmentId:accepted.environment.environmentId};
 await writeFile(path.join(work,'service.json'),JSON.stringify(metadata,null,2));console.log(JSON.stringify({url,work,status:'READY_FOR_UI'}));
 process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());let releaseReady=false;
 while(!closed){assert.equal(child.exitCode,null,'Builder fixture stopped');
  if(!releaseReady)try{const release=JSON.parse(await readFile(path.join(state,'connection-info.json'),'utf8'));process.env.REBUILD_UI_RELEASE_TOKEN=release.token;releaseReady=true;console.log('READY: import the actual Builder Result through the UI');}catch(e){if(e.code!=='ENOENT')throw e}
  try{await readFile(path.join(work,'stop'));await shutdown()}catch(e){if(e.code!=='ENOENT')throw e}
  await new Promise(r=>setTimeout(r,500));
 }
}finally{await shutdown();if(stdout)await writeFile(path.join(work,'builder-private-stdout.log'),stdout);
 if(stderr)await writeFile(path.join(work,'builder-private.log'),stderr);}
