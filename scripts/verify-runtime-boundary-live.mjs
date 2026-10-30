// Real Builder, migration Agent, Runtime and Judge. No injected ports or replay.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chown,mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {zipSync} from 'fflate';
if(process.env.BOUNDARY_ENV_FILE)process.loadEnvFile(process.env.BOUNDARY_ENV_FILE);
const root=process.cwd(),out=process.env.BOUNDARY_REPORT_DIR;
assert(out&&process.env.BOUNDARY_BUILDER_ROOT&&process.env.BOUNDARY_BUILDER_PYTHON&&process.env.BOUNDARY_RUNTIME_PYTHON&&process.env.FINANCE_RUNTIME_CONFIG);
await mkdir(out,{recursive:true,mode:0o700});
process.env.FINANCE_EVAL_MIGRATION_PROJECT_ROOT=root;
process.env.FINANCE_EVAL_MIGRATION_PYTHON=process.env.BOUNDARY_RUNTIME_PYTHON;
process.env.FINANCE_EVAL_MIGRATION_AGENT='on';
process.env.NODE_ENV='production';
const builderRoot=process.env.BOUNDARY_BUILDER_ROOT,hostPython=process.env.BOUNDARY_BUILDER_PYTHON;
const state=path.join(out,'release'),port=Number(process.env.BOUNDARY_LAUNCHER_PORT??19188),baseUrl=`http://127.0.0.1:${port}/oj/`;
const containerImage=process.env.BOUNDARY_CONTAINER_IMAGE;
const containerName=process.env.BOUNDARY_CONTAINER_NAME??'finance-runtime-eval-verification';
const containerVolume=process.env.BOUNDARY_CONTAINER_VOLUME??'finance-runtime-eval-verification-state';
process.env.BOUNDARY_LAUNCHER_TOKEN=(await readFile(process.env.BOUNDARY_LAUNCHER_CREDENTIAL,'utf8')).trim();
const {createEvaluationService}=await import('../dist/service/server.js');
const {configuredModelRole}=await import('../dist/service/config.js');
assert(configuredModelRole('JUDGE').configured,'A real Judge is required');
const token=randomUUID(),headers={authorization:'Bearer '+token};
const app=await createEvaluationService({rootDirectory:root,dataDirectory:path.join(out,'data'),publicDirectory:path.join(root,'web-dist'),accessToken:token,publicDemo:false,
  launcherTrust:[{reference:'boundary-live',label:'Runtime boundary live',baseUrlPrefix:baseUrl,credentialEnv:'BOUNDARY_LAUNCHER_TOKEN'}]});
app.log.level='warn';
const summary={status:'RUNNING',mode:'REAL_BUILDER_AGENT_RUNTIME_JUDGE',tasks:[],checks:[]};
let deployment, runtimeCreated=false;
const save=()=>writeFile(path.join(out,'summary.json'),JSON.stringify(summary,null,2));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function api(method,url,payload,extra={}){
  const response=await app.inject({method,url,headers:{...headers,...extra},...(payload!==undefined?{payload}:{})});
  assert.equal(response.statusCode>=200&&response.statusCode<300,true,`${url}: ${response.statusCode} ${response.body.slice(0,500)}`);
  return response.headers['content-type']?.includes('json')?response.json():response.rawPayload;
}
async function operation(task,kind,body={}){
  const prefix='/api/migration-tasks/'+task.id;
  await api('POST',prefix+'/'+kind,{key:randomUUID(),baseCandidateId:task.currentCandidateId,...body});
  const deadline=Date.now()+900000;let previous='';
  while(Date.now()<deadline){
    task=await api('GET',prefix);const attempt=task.attempts.at(-1);
    if(attempt.message!==previous){console.log(kind+': '+attempt.message);previous=attempt.message;}
    if(attempt.status!=='RUNNING'){assert.equal(attempt.status,'COMPLETED',attempt.error);return task;}
    await pause(1500);
  }
  throw new Error('REAL_AGENT_OPERATION_TIMEOUT');
}
async function builder(command,args){
  const child=spawn(hostPython,[path.join(builderRoot,'engineering',command),...args],{cwd:builderRoot,env:process.env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  assert.equal(code,0,'Builder command failed: '+output.slice(-500));
  return output;
}
async function container(action,extra=[]){
  return builder('runtime_container.py',[action,'--image',containerImage,'--name',containerName,'--volume',containerVolume,'--port',String(port),...extra]);
}
async function containerResult(){
  const child=spawn('docker',['exec',containerName,'/opt/host/bin/python','-c',"from pathlib import Path; print(Path('/state/release/result.json').read_text())"],{stdio:['ignore','pipe','inherit']});
  let output='';child.stdout.on('data',chunk=>{output+=chunk;});
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  assert.equal(code,0,'Container result read failed');
  return JSON.parse(output);
}
try{
  await save();
  for(const count of [1,3]){
    const files={};
    const names=count===1?['document-review']:['read-facts','check-rule','write-report'];
    for(const [index,name] of names.entries())files[`skills/${name}/SKILL.md`]=Buffer.from(`---\nname: ${name}\ndescription: Document review step ${index+1}.\n---\n${count===1?'Read facts.json with read_file. Decide ACCEPT when amount <= limit, otherwise REJECT. Report amount, limit, the exact decision label and that no external action was taken.':index===0?'Read facts.json with read_file and hand the exact amount and limit to check-rule.':index===1?'Use the facts from read-facts. Decide ACCEPT when amount <= limit, otherwise REJECT. Pass the decision to write-report.':'Use the facts and decision from the other Skills. Report amount, limit, decision and that no external action was taken.'}\nNever invent missing facts. Missing amount or limit means UNAVAILABLE. Use every relevant installed Skill with skill_tool.\n`);
    let task=await api('POST','/api/migration-tasks/upload?name='+encodeURIComponent(`Runtime collection ${count}`)+'&goal='+encodeURIComponent('Read document facts, apply the threshold rule, report without external actions.')+'&target='+encodeURIComponent('OpenJiuwen Runtime with skills[] at startup. Keep all Skill members and instructions; use read_file for case workspace data.'),Buffer.from(zipSync(files)),{'content-type':'application/zip'});
    task=await operation(task,'analysis');task=await operation(task,'generate');
    const prefix='/api/migration-tasks/'+task.id;
    if(!deployment){
      task=await api('POST',prefix+'/runtime-build-requests',{baseCandidateId:task.currentCandidateId,runtimeType:'openjiuwen',platform:{os:process.platform==='win32'?'windows':'linux',arch:process.arch,isolation:'trusted_local_process'},timeoutMs:310000,harnessTools:['read_file','list_files','glob']});
      const request=task.runtimeBuildRequests.at(-1).requirements;
      assert(!('source'in request)&&!('extensions'in request));
      const reqFile=path.join(out,'requirements.json');await writeFile(reqFile,JSON.stringify(request));
      if(containerImage){
        assert(process.platform==='linux','Standalone image validation uses Linux Docker host networking');
        const configDir=path.join(out,'container-config');await mkdir(configDir,{mode:0o700});
        assert([0,10001].includes(process.getuid()),'Container verification config requires root or UID 10001');
        for(const [name,source] of [['requirements.json',reqFile],['model.json',process.env.FINANCE_RUNTIME_CONFIG],['launcher-token',process.env.BOUNDARY_LAUNCHER_CREDENTIAL]])
          await writeFile(path.join(configDir,name),await readFile(source),{mode:0o400});
        if(process.getuid()===0){
          for(const name of ['requirements.json','model.json','launcher-token'])await chown(path.join(configDir,name),10001,10001);
          await chown(configDir,10001,10001);
        }
        await container('init',['--config-dir',configDir]);
        await container('start');
        runtimeCreated=true;
        const deadline=Date.now()+180000;
        while(Date.now()<deadline){
          try{const response=await fetch(baseUrl+'v1/runtime-capabilities',{headers:{authorization:'Bearer '+process.env.BOUNDARY_LAUNCHER_TOKEN}});if(response.ok)break;}catch{}
          await pause(1000);
        }
        await container('verify',['--skills','1']);
      }else await builder('build_runtime.py',['--requirements',reqFile,'--state-root',state,'--python',process.env.BOUNDARY_RUNTIME_PYTHON,'--model-config',process.env.FINANCE_RUNTIME_CONFIG,'--credential-file',process.env.BOUNDARY_LAUNCHER_CREDENTIAL,'--port',String(port)]);
      runtimeCreated=true;
      const result=containerImage?await containerResult():JSON.parse(await readFile(path.join(state,'result.json'),'utf8'));
      task=await api('POST',prefix+'/runtime-deliveries',{result,trustReference:'boundary-live'});
      deployment=task.runtimeDelivery;summary.checks.push('build_process_exited_before_runtime_intake');
    }else task=await api('PUT',prefix+'/configuration',{environmentId:deployment.launcher.environmentId,modelId:summary.tasks[0].modelId,timeoutMs:310000,harnessTools:['read_file','list_files','glob']});
    const ready=await api('POST',prefix+'/runtime-check',{});assert.equal(ready.scope,'INSTANCE_START_AND_RELEASE');
    const amount=127+count,limit=100+count;
    task=await api('PUT',prefix+'/suite',{name:'Independent document checks',cases:[{id:'over',input:'Activate all installed Skills and review facts.json.',workspaceFiles:[{path:'facts.json',content:JSON.stringify({amount,limit})}],criteria:[`Actual file read; amount ${amount}, limit ${limit}, REJECT; no external action taken.`]}],holdoutCases:[{id:'missing',input:'Activate all installed Skills and review facts.json.',workspaceFiles:[{path:'facts.json',content:JSON.stringify({limit:1000+count})}],criteria:['Actual file read. Missing amount means UNAVAILABLE; no invented amount or external action.']}]});
    task=await operation(task,'acceptance');assert.equal(task.runs.at(-1).status,'PASSED',JSON.stringify(task.runs.at(-1).cases));
    task=await operation(task,'acceptance',{phase:'holdout'});assert.equal(task.runs.at(-1).status,'PASSED',JSON.stringify(task.runs.at(-1).cases));
    await api('GET',prefix+'/export?verified=true');
    assert.equal(task.runs.at(-1).runtimeSnapshot.delivery.deploymentId,deployment.launcher.deploymentId);
    assert.equal(task.runs.at(-1).cases[0].evidence.metadata.loadedSkillMembers.length,count);
    summary.tasks.push({taskId:task.id,members:count,modelId:task.configuration.modelId,deploymentId:deployment.launcher.deploymentId,artifactSha256:deployment.launcher.artifactSha256,development:'PASSED',holdout:'PASSED'});
    await writeFile(path.join(out,`task-${count}.json`),JSON.stringify(task,null,2));await save();
  }
  summary.checks.push('same_runtime_artifact_for_distinct_skill_collections');summary.status='PASSED';
}catch(error){summary.status='FAILED';summary.error=error.message;throw error;}
finally{await app.close();if(runtimeCreated){if(containerImage)await container('stop');else await builder('runtime_host.py',['revoke','--state-root',state]);}await save();console.log(JSON.stringify(summary));}
