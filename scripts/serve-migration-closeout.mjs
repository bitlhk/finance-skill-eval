/** Disposable, real-model service for manual browser acceptance. No seeded results. */
import assert from 'node:assert/strict';
import {spawn,execFileSync} from 'node:child_process';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {createAcceptanceWorkspace} from './lib/acceptance-workspace.mjs';
import {createEvaluationService} from '../dist/service/server.js';
import {configuredModelRole} from '../dist/service/config.js';
import {pinnedBuilderSource} from './lib/pinned-builder-source.mjs';

const root=process.cwd(),work=await createAcceptanceWorkspace('migration-closeout-',root);
const builder=process.env.CLOSEOUT_BUILDER_ROOT??path.resolve(root,'../agent-store-builder-dev-wo-fork/community/finance/builder/finance-solution-builder');
const python=process.env.CLOSEOUT_PACKAGE_PYTHON??'C:/fb-pkg-py317/Scripts/python.exe';
const builderPython=process.env.CLOSEOUT_BUILDER_PYTHON??path.join(builder,'../.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
function version(directory,scope=[]){
  const git=(...args)=>execFileSync('git',args,{cwd:directory,encoding:'utf8',windowsHide:true}).trim();
  const commit=git('rev-parse','HEAD');
  const changed=git('diff','--name-only','HEAD','--',...scope),untracked=git('ls-files','--others','--exclude-standard','--',...scope);
  assert(!changed&&!untracked,'Commit the scoped acceptance implementation before running version-pinned UI acceptance');
  return {commit,clean:true};
}
const versions={eval:version(root),builder:version(builder,['.','../base','../pyproject.toml','../uv.lock']),
  harness:version(process.env.CLOSEOUT_HARNESS_ROOT??path.resolve(root,'../finance-agent-harness-eval-generation-windows'))};
const pinnedBuilder=await pinnedBuilderSource({project:builder,commit:versions.builder.commit,destination:work});
await writeFile(path.join(work,'versions.json'),JSON.stringify({versions,launcherBackend:'NATIVE_PACKAGE',harnessExecution:'NOT_USED',builderSource:'COMMITTED_ISOLATED_EXPORT'},null,2));
const cfg=JSON.parse(await readFile(path.join(root,'.runtime.local.json'),'utf8'));
const [,model]=Object.entries(cfg.models).find(([,m])=>m.enabled!==false);
assert(model.apiKey&&model.baseUrl&&model.upstreamModelId,'Configured real execution model required');
// Explicit test-process opt-in, never persist production role or credential changes.
if(process.env.CLOSEOUT_OPTIMIZER_ROLE){
  assert(['ANALYZER','MIGRATION'].includes(process.env.CLOSEOUT_OPTIMIZER_ROLE));
  for(const suffix of ['PROVIDER','BASE_URL','API_KEY','MODEL','REQUEST_DEFAULTS','TIMEOUT_MS']){
    const value=process.env[`FINANCE_EVAL_${process.env.CLOSEOUT_OPTIMIZER_ROLE}_${suffix}`];
    if(value===undefined)delete process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`];else process.env[`FINANCE_EVAL_OPTIMIZER_${suffix}`]=value;
  }
}
for(const role of ['ANALYZER','MIGRATION','JUDGE','OPTIMIZER'])assert(configuredModelRole(role).adapter,`Missing real ${role} model`);
process.env.FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS='1';
process.env.FINANCE_EVAL_AGENT_DUMP=path.join(work,'agent-logs');
const state=path.join(work,'launcher');await mkdir(state,{recursive:true});
// Use a provisioned interpreter; do not resync/reinstall dependencies into the
// developer's live workspace or require downloads during a pinned acceptance.
const child=spawn(builderPython,['-B','engineering/verify_eval_package_native.py',
  '--state-root',state,'--python',python,'--model-base',model.baseUrl,'--model-name',model.upstreamModelId,
  '--model-key-env','CLOSEOUT_RUNTIME_MODEL_KEY','--port','0','--serve','--capture-tool-results'],
  {cwd:pinnedBuilder,windowsHide:true,env:{...process.env,PYTHONUTF8:'1',CLOSEOUT_RUNTIME_MODEL_KEY:model.apiKey},stdio:['ignore','pipe','pipe']});
let app,closed=false;child.stdout.resume();let helperError='';child.stderr.on('data',chunk=>{helperError=(helperError+chunk).slice(-200000)});
async function shutdown(){if(closed)return;closed=true;await app?.close();await writeFile(path.join(state,'stop'),'stop');
  await new Promise(resolve=>{if(child.exitCode!==null)return resolve();const timer=setTimeout(()=>{child.kill();resolve()},15000);child.once('exit',()=>{clearTimeout(timer);resolve()})});}
try{
  let info;for(let i=0;i<120;i++){assert.equal(child.exitCode,null,'Test Launcher exited');try{info=JSON.parse(await readFile(path.join(state,'connection-info.json'),'utf8'));if(info.status==='READY')break}catch{}
    await new Promise(r=>setTimeout(r,500));}
  assert.equal(info?.status,'READY','Test Launcher startup failed');
  process.env.CLOSEOUT_LAUNCHER_CREDENTIAL=info.token;
  app=await createEvaluationService({rootDirectory:root,dataDirectory:path.join(work,'data'),publicDirectory:path.join(root,'web-dist'),
    publicDemo:false,accessToken:'migration-closeout-ui'});app.log.level='error';
  const registration=await app.inject({method:'POST',url:'/api/environments',headers:{authorization:'Bearer migration-closeout-ui'},
    payload:{name:'闭环验收 Runtime',type:'runtime_launcher',runtimeType:'openjiuwen',baseUrl:info.baseUrl,credentialEnv:'CLOSEOUT_LAUNCHER_CREDENTIAL'}});
  assert.equal(registration.statusCode,200,'Real Launcher registration failed');
  const url=await app.listen({host:'127.0.0.1',port:0});
  await writeFile(path.join(work,'service.json'),JSON.stringify({url,data:path.join(work,'data'),environmentId:registration.json().environmentId,
    reportRoot:work,versions,provenance:'FRESH_REAL_MODELS_NATIVE_PACKAGE_LAUNCHER'}));
  console.log(JSON.stringify({url,reportRoot:work,mode:'FRESH_REAL_MODELS_NATIVE_PACKAGE_LAUNCHER'}));
  process.once('SIGINT',()=>void shutdown());process.once('SIGTERM',()=>void shutdown());
  while(!closed){if(child.exitCode!==null)throw new Error('Private Launcher stopped');
    try{await readFile(path.join(work,'stop'));await shutdown()}catch(error){if(error.code!=='ENOENT')throw error}
    await new Promise(r=>setTimeout(r,500));}
}finally{await shutdown();if(helperError)await writeFile(path.join(work,'launcher-private.log'),helperError);}
