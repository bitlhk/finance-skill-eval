/** Real A2 -> reused live A4 delivery -> DeepAgent HTTP Runtime -> real comparison Judge. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {createEvaluationService} from '../dist/service/server.js';
import {analyzeWithAgent} from '../dist/service/migration-agent.js';

const root=process.cwd(),prior=path.resolve(process.argv[2]??'reports/harness-migration-live-2026-09-17T13-21-02-986Z');
const originalConfig=JSON.parse(await readFile(path.join(root,'.runtime.local.json'),'utf8'));
const [modelId,model]=Object.entries(originalConfig.models).find(([,value])=>value.enabled!==false);
process.env.FINANCE_EVAL_JUDGE_PROVIDER='openai_compatible';
process.env.FINANCE_EVAL_JUDGE_BASE_URL=model.baseUrl;
process.env.FINANCE_EVAL_JUDGE_API_KEY=model.apiKey;
process.env.FINANCE_EVAL_JUDGE_MODEL=model.upstreamModelId??modelId;
process.env.FINANCE_EVAL_JUDGE_REQUEST_DEFAULTS=JSON.stringify({...model.extraBody,max_tokens:32000});
const savedA2=process.argv[3]?path.resolve(process.argv[3]):null;
const live=JSON.parse(await readFile(path.join(prior,'agent-result.json'),'utf8'));
assert.equal(live.status,'PRODUCED');
const declaration=live.payload.judgement.harnessPlugins[0];
const originalImplementation=Buffer.from(live.payload.files[declaration.implementationFiles[0]],'base64').toString('utf8');
const report=path.join(root,'reports','original-service-comparison-'+new Date().toISOString().replace(/[:.]/gu,'-'));
await mkdir(report,{recursive:true});
const work=await mkdtemp(path.join(os.tmpdir(),'original-service-comparison-'));
assert.equal(path.dirname(work),path.resolve(os.tmpdir()));
const python=path.join(root,'.venv-openjiuwen/Scripts/python.exe');
const token='controlled-baseline-secret';
const secrets=[token,...Object.values(originalConfig.models).map(value=>value.apiKey).filter(Boolean)];
async function save(name,value){let text=JSON.stringify(value,null,2);for(const secret of secrets)text=text.replaceAll(secret,'[redacted]');await writeFile(path.join(report,name),text)}
let app,worker,baseline;const audit=[];const previousToken=process.env.ORIGINAL_SERVICE_TEST_TOKEN;
process.env.ORIGINAL_SERVICE_TEST_TOKEN=token;
async function port(){const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const value=server.address().port;await new Promise(resolve=>server.close(resolve));return value}
try{
 const workspace=path.join(work,'workspace');await mkdir(workspace);await writeFile(path.join(workspace,'sample.txt'),'迁移前后的内容必须一致。');
 await writeFile(path.join(work,'original.py'),originalImplementation);
 const configFile=path.join(work,'runtime.json');await writeFile(configFile,JSON.stringify({...originalConfig,workspaceDirectory:workspace}));
 const workerPort=await port();let workerLog='';
 worker=spawn(python,['-B','-m','uvicorn','integrations.openjiuwen.worker:app','--host','127.0.0.1','--port',String(workerPort)],{cwd:root,windowsHide:true,env:{...process.env,FINANCE_RUNTIME_CONFIG:configFile,PYTHONUTF8:'1'},stdio:['ignore','pipe','pipe']});
 worker.stdout.on('data',bytes=>workerLog+=bytes);worker.stderr.on('data',bytes=>workerLog+=bytes);
 const workerUrl=`http://127.0.0.1:${workerPort}`;
 for(let attempt=0;attempt<90;attempt++){
  if(worker.exitCode!==null)throw Error('Worker exited before startup');
  try{const health=await fetch(workerUrl+'/health',{signal:AbortSignal.timeout(1000)});if(health.ok){await save('worker-health.json',await health.json());break}}catch{}
  if(attempt===89)throw Error('Worker did not become ready');
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 baseline=createServer(async(req,res)=>{
  try{
   let text='';for await(const chunk of req)text+=chunk;const body=JSON.parse(text);
   const authorized=req.headers.authorization===`Bearer ${token}`;
   audit.push({authorized,caseId:body.case_id,task:body.request?.message,criteriaReceived:Object.hasOwn(body,'criteria')});
   if(!authorized){res.writeHead(403);res.end();return}
   assert.ok(typeof body.request?.message==='string');assert.ok(typeof body.case_id==='string');
   // Run the original implementation, outside the migrated plugin and target Runtime.
   const child=spawn(python,['-B','-c','import json;from original import read_document;print(json.dumps(read_document("sample.txt")))'],{cwd:workspace,windowsHide:true,env:{...process.env,PYTHONPATH:work,PYTHONUTF8:'1'},stdio:['ignore','pipe','pipe']});
   let output='';child.stdout.on('data',bytes=>output+=bytes);const exit=await new Promise(resolve=>child.once('close',resolve));assert.equal(exit,0);
   res.setHeader('content-type','application/json');res.end(JSON.stringify({data:{result:JSON.parse(output)}}));
  }catch{res.writeHead(500);res.end()}
 });await new Promise(resolve=>baseline.listen(0,'127.0.0.1',resolve));
 const baselineUrl=`http://127.0.0.1:${baseline.address().port}/original/run`;
 console.log(savedA2?'Worker ready. Reusing real A2/A4 outputs for the same source.':'Worker ready. Running real A2; reusing prior live A4 plugin delivery.');
 app=await createEvaluationService({rootDirectory:root,dataDirectory:path.join(work,'data'),publicDemo:false,accessToken:'local-comparison-test',
  migrationAnalyzer:async input=>{const result=savedA2?JSON.parse(await readFile(path.join(savedA2,'a2-result.json'),'utf8')):await analyzeWithAgent(input,{projectRoot:root,modelId,providerId:model.providerId??'service-execution',timeoutMs:900000});await save('a2-result.json',result);return result},
  migrationImplementer:async input=>{
   assert.equal(Buffer.from(input.files['tools/original.py']).toString('utf8'),originalImplementation);
   await save('a4-reuse.json',{mode:'REUSE_PREVIOUS_LIVE_MODEL_DELIVERY',prior,originalAgentRun:live.run});
   return {status:'PRODUCED',payload:live.payload.judgement,files:live.payload.files};
  }});
 app.log.level='error';
 async function api(method,url,payload,extra={}){const response=await app.inject({method,url,headers:{authorization:'Bearer local-comparison-test',...extra},...(payload===undefined?{}:{payload})});assert.ok(response.statusCode<400,`${url}: ${response.statusCode} ${response.body.slice(0,2000)}`);return response.json()}
 const inputSchema={type:'object',properties:{path:{type:'string'}},required:['path']};
 const source={
  'SKILL.md':'---\nname: document-harness-demo\nversion: 1.0.0\ndescription: Read a user document using the original Runtime Harness.\n---\nCall read_document with path="sample.txt" and return its content and implementation marker. The test user document is supplied in the Runtime workspace. Keep the original tool name. On file errors report failure without inventing content.\n',
  'tools/original.py':originalImplementation,
  'tools/registration.json':JSON.stringify({owner:'RUNTIME_HARNESS',runtime:'original-runtime',toolName:'read_document',implementation:'original.read_document',inputSchema,description:'Framework-level filesystem harness; not a Skill business tool.'}),
 };
 const sourceZip=savedA2?await readFile(path.join(savedA2,'source.zip')):Buffer.from(zipSync(Object.fromEntries(Object.entries(source).map(([file,text])=>[file,strToU8(text)]))));
 const decodedSource=unzipSync(sourceZip);for(const [name,text] of Object.entries(source))assert.equal(Buffer.from(decodedSource[name]).toString('utf8'),text,'Saved A2 must refer to the exact same source files');await writeFile(path.join(report,'source.zip'),sourceZip);
 const sourceAsset=await api('POST','/api/skills/upload',sourceZip,{'content-type':'application/zip'});
 const project=await api('POST','/api/migrations',{sourceAssetId:sourceAsset.assetId,name:'原服务真实对比'}),url=`/api/migrations/${project.id}`;
 const inspection=await api('POST',url+'/inspect');await save('inspection.json',inspection);
 assert.deepEqual(inspection.runtimeCapabilities.map(capability=>capability.name),['read_document']);assert.equal(inspection.tools.length,0);
 const generated=await api('POST',url+'/generate',{baseAssetId:sourceAsset.assetId});await save('candidate.json',generated);const candidate=generated.candidate;
 const suite=await api('POST',url+'/suites/import',{name:'文档原服务对比',cases:[
  {id:'equivalent',input:'读取工作区 sample.txt 并告诉我文档内容和实现标记。',criteria:['文档内容为“迁移前后的内容必须一致。”，实现标记为 ORIGINAL_HARNESS_7F31。']},
  {id:'wrong-target',input:'读取工作区 sample.txt 并告诉我文档内容和实现标记。',criteria:['文档内容必须为“这个验收目标故意写错”。']},
 ]});
 const environment=await api('POST','/api/environments',{name:'DeepAgent 真实对比',type:'runtime_http',runtimeType:'openjiuwen',endpoint:workerUrl+'/execute'});
 const variant=asset=>({mode:'skill_version',skillId:asset.skillId,version:asset.version,artifactSha256:asset.artifactSha256});
 const experiment=await api('POST',url+'/validate/openjiuwen',{pair:'SC',dataSnapshot:'冻结同一工作区文档',permissionBasis:'受控只读测试',sourceProjectRef:'original.py',dependencyLockRef:'openjiuwen-0.1.17.post1',configuration:{preparationId:suite.preparationId,runtime:{type:'runtime_http',environmentId:environment.environmentId},evaluationMode:'service_comparison',judgeMode:'model',timeoutMs:600000,executionModel:{providerId:model.providerId??'service-execution',modelId,parameters:{}},leftVariant:variant(sourceAsset),rightVariant:variant(candidate),runtimeBindings:{left:{environmentId:environment.environmentId,skillAssetId:sourceAsset.assetId},right:{environmentId:environment.environmentId,skillAssetId:candidate.assetId}},originalService:{endpoint:baselineUrl,requestTemplate:{request:{message:'{{input}}'},case_id:'{{caseId}}'},responseFormat:'json',responsePointer:'/data/result',headers:[{name:'Authorization',env:'ORIGINAL_SERVICE_TEST_TOKEN',prefix:'Bearer '}]}}});
 console.log('Original service + real DeepAgent execution + real comparison Judge running.');
 let job;
 for(let attempt=0;attempt<900;attempt++){
  job=await api('GET','/api/runs/'+experiment.job.jobId);
  if(['completed','failed','cancelled','interrupted'].includes(job.status))break;
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 await save('job.json',job);assert.equal(job.status,'completed',JSON.stringify(job.error));
 const reportResult=await api('GET',url+'/report');await save('migration-report.json',reportResult);await save('baseline-audit.json',audit);
 assert.equal(reportResult.verification.originalBaseline,'CAPTURED');
 for(const result of job.report.cases){assert.equal(result.left.status,'completed');assert.equal(result.right.status,'completed');assert.equal(result.left.runtimeIdentityVerified,false);assert.equal(result.right.metadata.skillArtifactSha256,candidate.artifactSha256);assert.ok(result.right.toolCalls.some(call=>call.name==='read_document'&&call.status==='completed'));assert.ok(!result.judgeError,result.judgeError);assert.equal(result.judge.serviceComparison.verdict,result.caseId==='equivalent'?'PASS':'FAIL')}
 assert.equal(audit.length,2);assert.ok(audit.every(call=>call.authorized&&!call.criteriaReceived));
 const exported=await app.inject({method:'GET',url:url+'/export',headers:{authorization:'Bearer local-comparison-test'}});assert.equal(exported.statusCode,200);await writeFile(path.join(report,'candidate-unverified.zip'),exported.rawPayload);
 const outcome={passed:true,scope:(savedA2?'Reused real A2 output (identical source ZIP), ':'Real A2, ')+'reused live A4 delivery, real original implementation via HTTP, real DeepAgent and comparison Judge; controlled credentials.',model:model.upstreamModelId??modelId,runtimeVersion:'0.1.17.post1',verdicts:job.report.cases.map(result=>({caseId:result.caseId,verdict:result.judge.serviceComparison.verdict})),report};await save('result.json',outcome);console.log(JSON.stringify(outcome));
}catch(error){await save('result.json',{passed:false,error:String(error),report});console.error(String(error));process.exitCode=1}
finally{
 await app?.close();if(baseline)await new Promise(resolve=>baseline.close(resolve));
 if(worker&&worker.exitCode===null){if(process.platform==='win32')await new Promise(resolve=>{const stop=spawn('taskkill',['/PID',String(worker.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});stop.once('close',resolve)});else worker.kill('SIGTERM')}
 if(previousToken===undefined)delete process.env.ORIGINAL_SERVICE_TEST_TOKEN;else process.env.ORIGINAL_SERVICE_TEST_TOKEN=previousToken;
 await rm(work,{recursive:true,force:true});
}
