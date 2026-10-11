/** Isolated real Builder admission; browser drives all migration operations. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,cp} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {pinnedBuilderSource} from './lib/pinned-builder-source.mjs';
import {createEvaluationService} from '../dist/service/server.js';
import {EnvironmentStore} from '../dist/service/environment-store.js';
import {SkillStore} from '../dist/service/skill-store.js';
import {runtimeSkillPackage} from '../dist/runtime-skill-package.js';
import {configuredModelRole} from '../dist/service/config.js';

const root=process.cwd(),work=await mkdtemp(path.join(os.tmpdir(),'cross-deployment-'));
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8',windowsHide:true}).trim();
assert(!git('status','--porcelain'),'Commit acceptance implementation before testing');
const builder=process.env.CLOSEOUT_BUILDER_ROOT??path.resolve(root,'../agent-store-builder-dev-wo-fork/community/finance/builder/finance-solution-builder');
const builderCommit=process.env.CLOSEOUT_BUILDER_COMMIT;
assert(builderCommit,'Explicit immutable Builder commit required');
const attempt={schemaVersion:1,startedAt:new Date().toISOString(),eval:git('rev-parse','HEAD'),builder:builderCommit,
 launcherBackend:'NATIVE_PACKAGE',harnessExecuted:false,status:'STARTING',admitted:[]};
await writeFile(path.join(work,'attempt.json'),JSON.stringify(attempt,null,2));
const pinned=await pinnedBuilderSource({project:builder,commit:builderCommit,destination:work});
const data=path.join(work,'data');
let continuation;
if(process.env.CLOSEOUT_SEED_DATA_WORK){
 const parentWork=path.resolve(process.env.CLOSEOUT_SEED_DATA_WORK);
 const parent=JSON.parse(await readFile(path.join(parentWork,'service.json'),'utf8'));
 assert(path.resolve(parent.data)===path.join(parentWork,'data'),'Explicit data owner required');
 assert(parent.launcherBackend==='NATIVE_PACKAGE','Only native acceptance data can be continued');
 await cp(parent.data,data,{recursive:true,errorOnExist:true});
 continuation={provenance:'CONTINUED_REAL_UI_DATA_NEW_DEPLOYMENTS',parentWork,parentEval:parent.eval};
}else await mkdir(data);
const skills=new SkillStore(data);await skills.initialize();
// Setup-only lifecycle probe. This does not seed a migration or a passing test.
const asset=await skills.uploadMigrationZip(await readFile(path.join(root,'acceptance/enterprise-migration-examples/01-expense/source.zip')));
const skill=runtimeSkillPackage({...asset,archive:await skills.readArchive(asset.assetId)});
const cfg=JSON.parse(await readFile(path.join(root,'.runtime.local.json'),'utf8'));
const model=Object.values(cfg.models).find(m=>m.enabled!==false);assert(model?.apiKey&&model?.baseUrl&&model?.upstreamModelId);
for(const role of ['ANALYZER','MIGRATION','JUDGE'])assert(configuredModelRole(role).adapter,`Missing real ${role}`);
for(const suffix of ['PROVIDER','BASE_URL','API_KEY','MODEL','REQUEST_DEFAULTS','TIMEOUT_MS']){
 const value=process.env[`FINANCE_EVAL_ANALYZER_${suffix}`];if(value!==undefined)process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`]=value;
}
process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS='1';
process.env.FINANCE_EVAL_AGENT_DUMP=path.join(work,'agent-logs');
const state=path.join(work,'launcher');
const child=spawn(process.env.CLOSEOUT_BUILDER_PYTHON??path.join(builder,'../.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),
 ['-B',path.join(root,'scripts/lib/serve-package-deployments.py'),'--builder-root',pinned,'--state-root',state,
 '--python',process.env.CLOSEOUT_PACKAGE_PYTHON??'C:/fb-pkg-py317/Scripts/python.exe'],
 {cwd:pinned,windowsHide:true,env:{...process.env,PYTHONUTF8:'1',CLOSEOUT_MODEL_BASE:model.baseUrl,CLOSEOUT_MODEL_NAME:model.upstreamModelId,
 CLOSEOUT_RUNTIME_MODEL_KEY:model.apiKey,CLOSEOUT_SOURCE_IDENTITY:JSON.stringify({assetId:asset.assetId,artifactSha256:asset.artifactSha256})},stdio:['ignore','pipe','pipe']});
child.stdout.resume();let stderr='';child.stderr.on('data',b=>{stderr=(stderr+b).slice(-200000)});
let app,closed=false;
async function shutdown(){if(closed)return;closed=true;await app?.close();await mkdir(state,{recursive:true});await writeFile(path.join(state,'stop'),'stop');
 await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill();resolve()},15000);child.once('exit',()=>{clearTimeout(timer);resolve()})});}
try{
 let delivery;for(let i=0;i<120;i++){assert.equal(child.exitCode,null,'Private deployment host failed');try{delivery=JSON.parse(await readFile(path.join(state,'deliveries.json'),'utf8'));break}catch{}await new Promise(r=>setTimeout(r,500));}
 assert.equal(delivery?.status,'READY','Private deployment host did not start');
 const trust=delivery.records.map((r,i)=>{const credentialEnv=`CLOSEOUT_DEPLOYMENT_${i}_TOKEN`;process.env[credentialEnv]=r.connection.token;
  return {reference:`acceptance-${i}`,label:`验收部署 ${i+1}`,baseUrlPrefix:r.connection.baseUrl,credentialEnv};});
 const environments=new EnvironmentStore(data,trust);await environments.initialize();const admitted=[];
 for(const [i,r] of delivery.records.entries()){
  const accepted=await environments.acceptBuilderDelivery({requirements:r.requirements,result:r.result,trustReference:trust[i].reference,
   name:`${continuation?'新进程回执验收部署':'复用验收部署'} ${i+1}`,conformance:{skill,requiredTools:[]}});
  admitted.push({environmentId:accepted.environment.environmentId,deploymentId:accepted.environment.delivery.deploymentId,
   artifactSha256:accepted.environment.delivery.artifactSha256,capabilitiesDigest:accepted.environment.delivery.capabilitiesDigest,
   evalConformance:accepted.environment.delivery.evalConformance});
  attempt.admitted=admitted;attempt.status='ADMITTING';
  await writeFile(path.join(work,'attempt.json'),JSON.stringify(attempt,null,2));
 }
 app=await createEvaluationService({rootDirectory:root,dataDirectory:data,publicDirectory:path.join(root,'web-dist'),publicDemo:false,
  accessToken:'cross-deployment-ui',launcherTrust:trust});app.log.level='error';
 const url=await app.listen({host:'127.0.0.1',port:0});
 const metadata={url,work,data,eval:attempt.eval,builder:builderCommit,launcherBackend:'NATIVE_PACKAGE',harnessExecuted:false,admitted,...continuation};
 await writeFile(path.join(work,'service.json'),JSON.stringify(metadata,null,2));console.log(JSON.stringify({url,work,admittedDeployments:admitted.length}));
 attempt.status='READY_FOR_UI';await writeFile(path.join(work,'attempt.json'),JSON.stringify(attempt,null,2));
 process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
 while(!closed){assert.equal(child.exitCode,null,'Private deployment host stopped');try{await readFile(path.join(work,'stop'));await shutdown()}catch(e){if(e.code!=='ENOENT')throw e}await new Promise(r=>setTimeout(r,500));}
}catch(error){
 attempt.status='FAILED';attempt.failedAt=new Date().toISOString();
 // Copy only stable codes, never arbitrary provider text, URLs or connection info.
 attempt.failureCode=String(error?.message??'').match(/\bEVAL_[A-Z0-9_]{1,80}\b/u)?.[0]??'ACCEPTANCE_HOST_FAILED';
 attempt.modelFailures=[...stderr.matchAll(/Package model call failed: category=(AUTH|RATE_LIMIT|UPSTREAM|REQUEST|TIMEOUT|TRANSPORT|RESPONSE|UNKNOWN) httpStatus=(None|[45][0-9]{2})/gu)]
  .map(m=>({category:m[1],...(m[2]==='None'?{}:{httpStatus:Number(m[2])})}));
 await writeFile(path.join(work,'attempt.json'),JSON.stringify(attempt,null,2));throw error;
}finally{await shutdown();if(stderr)await writeFile(path.join(work,'launcher-private.log'),stderr);}
