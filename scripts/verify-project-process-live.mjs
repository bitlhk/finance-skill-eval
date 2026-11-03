import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {mkdtemp,readdir,readFile,writeFile,mkdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import Fastify from 'fastify';
import {RuntimeLauncherAdapter} from '../dist/runtime-launcher.js';
import {projectSnapshot} from '../dist/migration/tasks/domain/task-model.js';
import {executeEvaluationCase} from '../dist/evaluation/application/execute-case.js';
import {evalCaseSchema} from '../dist/contracts.js';
import {canonicalSha256} from '../dist/shared/json-canonicalization.js';
import {createCriterionJudge} from '../dist/agents/criterion-judge.js';
import {OpenAiCompatibleModelAdapter} from '../dist/openai-compatible-model.js';
import {inspectRuntimeIntake} from '../dist/evaluation/application/runtime-intake.js';
import {pathToFileURL} from 'node:url';
import net from 'node:net';

// Opt-in live test: real model, real original Agent API, real isolated business HTTP service.
// This example bridge is not a generic project adapter or a replacement Builder.
export async function createLiveProjectLauncher(projectPath,{port=0,businessPort=0}={}){
assert.ok(projectPath,'Pass the AgentScope example project path');
const project=path.resolve(projectPath);
const apiKey=process.env.FINANCE_EVAL_MODEL_API_KEY,baseUrl=process.env.FINANCE_EVAL_MODEL_BASE_URL;
const modelId=process.env.FINANCE_EVAL_MODEL;
assert.ok(apiKey&&baseUrl&&modelId,'Platform model configuration is required');
const folder=await mkdtemp(path.join(os.tmpdir(),'finance-live-project-'));
if(!businessPort){
  const reservation=net.createServer();
  await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));
  businessPort=reservation.address().port;
  await new Promise(resolve=>reservation.close(resolve));
}
const businessUrl='http://127.0.0.1:'+businessPort;
const files={};
async function collect(directory,relative=''){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(entry.isSymbolicLink()||['.venv','.git','__pycache__','.pytest_cache','data','logs'].includes(entry.name)||(entry.name.startsWith('.env')&&entry.name!=='.env.example'))continue;
    const name=relative?relative+'/'+entry.name:entry.name;
    if(entry.isDirectory())await collect(path.join(directory,entry.name),name);
    else if(/\.(py|md|toml|lock|json|yaml|yml|txt|ps1|sh|bat|example)$/.test(name)){
      files[name]=(await readFile(path.join(directory,entry.name))).toString('base64');
    }
  }
}
await collect(project);
const frozen=projectSnapshot(files),instances=new Map(),lifecycle=[];
const caps={schemaVersion:'finance.runtime-capabilities.v1',instanceSchemaVersion:'finance.runtime-instance.v1',
  platform:{os:process.platform==='win32'?'windows':'linux',arch:process.arch,isolation:'trusted_local_process'},
  runtime:{type:'agentscope',version:'1.0.21'},models:[{modelId,upstreamModelId:modelId}],defaultModelId:modelId,
  features:{processEvidence:true,projectExecution:true,toolEnvironment:true,streaming:false,asyncLaunch:false,packagedMcp:false,externalMcp:false,inlineSecrets:true},
  limits:{maxArchiveBytes:8388608,maxFiles:1000,maxTimeoutMs:240000,maxConcurrentInstances:1}};
const host=Fastify();
const state=id=>({schemaVersion:'finance.skill-eval.runtime-instance-state.v1',instanceId:id,status:'ready',
  executeEndpoint:'/v1/runtime-instances/'+id+'/execute',expiresAt:new Date(Date.now()+600000).toISOString(),
  configurationDigest:canonicalSha256(instances.get(id))});
host.get('/v1/runtime-capabilities',()=>caps);
host.post('/v1/runtime-instances',async request=>{
  const incomingFiles={...request.body.assets};
  for(const skill of request.body.skills??[]){
    incomingFiles[skill.skillFile]=Buffer.from(skill.instructions).toString('base64');
    for(const [name,value] of Object.entries(skill.files??{}))incomingFiles[name]=value;
  }
  const incoming=projectSnapshot(incomingFiles);
  assert.equal(incoming.digest,request.body.contentDigest);
  const id=randomUUID(),root=path.join(folder,id);
  for(const [name,value] of Object.entries(incoming.files)){
    const target=path.join(root,name);await mkdir(path.dirname(target),{recursive:true});await writeFile(target,Buffer.from(value,'base64'));
  }
  instances.set(id,request.body);lifecycle.push('create');return state(id);
});
host.get('/v1/runtime-instances/:id',request=>state(request.params.id));
host.post('/v1/runtime-instances/:id/execute',async request=>{
  const id=request.params.id,instance=instances.get(id),started=Date.now();
  const toolEnvironment={};
  const allowed=new Set(['MEETINGROOM_BASE_URL','MEETINGROOM_API_KEY','OPENAI_API_KEY','OPENAI_BASE_URL','OPENAI_MODEL','MULTI_MODEL_NAME','MULTI_MODEL_API_KEY','MULTI_MODEL_BASE_URL','IMAGE_ROOT','IMAGE_ALLOWED_HOSTS']);
  for(const [key,value] of Object.entries({...instance.configuration,...instance.secrets?.values})){
    assert.ok(key.startsWith('tool.env.')&&allowed.has(key.slice(9)),'Unsupported configuration');
    toolEnvironment[key.slice(9)]=value;
  }
  if(toolEnvironment.MEETINGROOM_BASE_URL)assert.equal(toolEnvironment.MEETINGROOM_BASE_URL,businessUrl,'Live tests must use the isolated business service');
  lifecycle.push('execute');
  const raw=await new Promise((resolve,reject)=>{
    const child=execFile(path.join(project,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python'),
      ['-B',path.resolve('scripts/lib/live-agentscope-project.py')],{
        cwd:path.join(folder,id),windowsHide:true,timeout:220000,maxBuffer:512000,
        env:{...process.env,PYTHONUTF8:'1',OPENAI_API_KEY:apiKey,OPENAI_BASE_URL:baseUrl,OPENAI_MODEL:modelId,...toolEnvironment,
          PROJECT_BUSINESS_PORT:String(businessPort),
          OTEL_EXPORTER_OTLP_TRACES_ENDPOINT:'',AGENT_API_KEY:'isolated-live',MEETINGROOM_API_KEY:toolEnvironment.MEETINGROOM_API_KEY??'isolated-live',
          AGENT_DB_PATH:path.join(folder,id,'sessions.sqlite3'),MEETINGROOM_DATA_FILE:path.join(folder,id,'rooms.json')},
      },(error,stdout)=>error?reject(new Error('Original Agent execution failed: '+error.code)):resolve(stdout));
    child.stdin.end(JSON.stringify({query:request.body.query}));
  });
  const result=JSON.parse(String(raw).trim().split('\n').at(-1));
  assert.equal(result.modelId,modelId);
  const loadedMembers=(instance.skills??[]).filter(member=>result.loadedSkillPaths?.includes(member.skillFile))
    .map(({instructions,files,...member})=>member);
  return {runId:instance.runId,caseId:request.body.caseId,side:'right',modelId,skillVersion:null,status:'completed',
    output:result.output,elapsedMs:Date.now()-started,toolCalls:[],loadedSkills:loadedMembers.map(m=>({skillId:m.skillId,version:m.version})),runtimeIdentityVerified:true,
    streamCompleted:true,error:null,metadata:{process:result.process,projectExecution:true,contentDigest:instance.contentDigest,
      loadedSkillMembers:loadedMembers,instanceConfigurationDigest:state(id).configurationDigest,workspaceFilesDigest:null}};
});
host.delete('/v1/runtime-instances/:id',request=>{
  instances.delete(request.params.id);lifecycle.push('cleanup');
  return {cleanup:{schemaVersion:'finance.eval-cleanup-observation.v1',instanceId:request.params.id,
    observedAt:new Date().toISOString(),status:'RELEASED',scope:'THIS_INSTANCE'}};
});
const url=await host.listen({host:'127.0.0.1',port});
return {url,host,folder,files,frozen,instances,lifecycle,caps,modelId,apiKey,baseUrl,businessUrl};
}
async function verify(){
const {url,host,folder,files,frozen,instances,lifecycle,caps,modelId,apiKey,baseUrl}=await createLiveProjectLauncher(process.argv[2]);
const model={providerId:'live',modelId,parameters:{}},variant={mode:'without_target_skill',skillId:'none'};
const runtime=new RuntimeLauncherAdapter({baseUrl:url,side:'right',model,variant,skill:null,
  skillSet:{executionMode:'agent_project',skills:[],assets:files,contentDigest:frozen.digest},
  environment:{environmentId:'isolated-agentscope-live'},timeoutMs:240000});
const runId=randomUUID();
try{
  const evalCase=evalCaseSchema.parse({caseId:'permission-readonly',name:'查询会议室权限',prompt:'请先读取会议室预订技能，再查询我有权限使用的会议室地点。只查询权限并告知地点，不预订、不修改、不取消，不需要查询空闲时段。',
    evaluationGoal:'真实查询并报告 U001 的会议室权限',
    rubric:[{criterionId:'locations',label:'权限地点',description:'回答当前用户可使用 A座和B座，有实际查询事件及结果支持。',dimension:'business_completeness',weight:1,scope:'execution'}]});
  await runtime.prepare({runId});
  console.log('LIVE_RUNTIME_STARTED');
  const evidence=await executeEvaluationCase({runtime,request:{runId,side:'right',evalCase,model,variant},failureMode:'throw'});
  const intake=inspectRuntimeIntake({capabilities:caps,evidence,identity:{runId,caseId:evalCase.caseId,side:'right'},features:['projectExecution']});
  assert.equal(intake.execution,'VERIFIED');
  assert.ok(evidence.metadata.process.records.some(r=>r.name==='get_permission_meetingroom_list'),'Actual permission tool event required');
  console.log('LIVE_AGENT_COMPLETED');
  const judge=createCriterionJudge({adapter:new OpenAiCompatibleModelAdapter({apiKey,baseUrl,timeoutMs:120000}),model});
  const judgement=await judge({evalCase,evidence},{requestId:randomUUID(),signal:AbortSignal.timeout(180000)});
  await runtime.cleanup();
  const report={runId,sourceDigest:frozen.digest,sourceModified:false,intake,evidence,judgement,lifecycle,
    boundary:'Real model + original Agent HTTP API + isolated business service + Launcher + shared evaluation. No Builder deployment or UI workflow exercised.'};
  const reportPath=path.join(folder,'report.json');await writeFile(reportPath,JSON.stringify(report,null,2));
  assert.equal(instances.size,0);
  console.log(JSON.stringify({reportPath,passed:judgement.passed,processStatus:evidence.metadata.process.status,lifecycle}));
  assert.equal(judgement.passed,true,'Business judgement did not pass; see saved report');
}finally{await runtime.cleanup().catch(()=>{});await host.close();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await verify();
