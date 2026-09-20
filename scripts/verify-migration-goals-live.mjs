import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import path from 'node:path';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {createEvaluationService} from '../dist/service/server.js';
import {simpleMigrationSuiteExample} from '../dist/service/simple-migration-suite.js';

const root=process.cwd(),source=path.resolve(process.argv[2]??'reports/migration-delivery-repack-2026-09-17T10-22-14.644Z');
const output=path.join(root,'reports',`migration-goals-live-${new Date().toISOString().replaceAll(':','-')}`);
await mkdir(output,{recursive:true});
const original=JSON.parse(await readFile(path.join(source,'result.json'),'utf8'));
const config=JSON.parse(await readFile(path.join(root,'.runtime.local.json'),'utf8'));
const [modelId,model]=Object.entries(config.models).find(([,m])=>m.enabled!==false);
assert(model.baseUrl&&model.apiKey);
process.env.FINANCE_EVAL_JUDGE_PROVIDER='openai_compatible';
process.env.FINANCE_EVAL_JUDGE_BASE_URL=model.baseUrl;process.env.FINANCE_EVAL_JUDGE_API_KEY=model.apiKey;
process.env.FINANCE_EVAL_JUDGE_MODEL=model.upstreamModelId??modelId;
process.env.FINANCE_EVAL_JUDGE_REQUEST_DEFAULTS=JSON.stringify(model.extraBody??{});
const token='live-goal-verification',credential='Bearer live-test-credential',calls=[],checks=[];
const safe=value=>{let text=JSON.stringify(value,null,2);for(const secret of [model.apiKey,credential])text=text.replaceAll(secret,'[redacted]');return text};
const save=(name,value)=>writeFile(path.join(output,name),safe(value));
const backend=createServer((request,response)=>{
 const url=new URL(request.url,'http://localhost');
 const call={path:url.pathname,accountId:url.searchParams.get('account'),credentialMatched:request.headers.authorization===credential,tenantMatched:request.headers['x-tenant-id']==='test-tenant'};calls.push(call);
 const accepted=call.path==='/balance'&&call.credentialMatched&&call.tenantMatched;
 response.writeHead(accepted?200:403,{'content-type':'application/json'});response.end(JSON.stringify(accepted?{account_id:call.accountId,balance:1000,currency:'CNY'}:{error:'forbidden'}));
});
await new Promise(resolve=>backend.listen(0,'127.0.0.1',resolve));
const probe=createServer();await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const runtimeBase=`http://127.0.0.1:${port}`,endpoint=runtimeBase+'/execute',businessUrl=`http://127.0.0.1:${backend.address().port}/balance`;
process.env.BALANCE_SERVICE_URL=businessUrl;
process.env.FINANCE_MIGRATION_NATIVE_ENDPOINT=endpoint;
const previousRuntimeEndpoint=process.env.FINANCE_OPENJIUWEN_ENDPOINT;process.env.FINANCE_OPENJIUWEN_ENDPOINT=endpoint;
const worker=spawn(path.join(root,'.venv-openjiuwen','Scripts','python.exe'),['-m','uvicorn','integrations.openjiuwen.worker:app','--host','127.0.0.1','--port',String(port)],{cwd:root,env:{...process.env,FINANCE_RUNTIME_CONFIG:path.join(root,'.runtime.local.json')},stdio:['ignore','pipe','pipe'],windowsHide:true});
let workerLog='';worker.stdout.on('data',data=>{workerLog+=data.toString()});worker.stderr.on('data',data=>{workerLog+=data.toString()});
let app,stage='RUNTIME_START',jobId;
try{
 const readyUntil=Date.now()+60000;let healthy=false;
 while(Date.now()<readyUntil){try{const res=await fetch(runtimeBase+'/health');if(res.ok){const health=await res.json();assert(health.models.includes(modelId));await save('runtime-health.json',health);healthy=true;break}}catch{}if(worker.exitCode!==null)throw Error('Runtime exited before health check');await new Promise(resolve=>setTimeout(resolve,500))}
 assert(healthy,'Runtime health check timed out');checks.push('真实 OpenJiuwen Runtime 启动');
 await cp(path.join(source,'service-data'),path.join(output,'service-data'),{recursive:true});
 app=await createEvaluationService({rootDirectory:root,dataDirectory:path.join(output,'service-data'),publicDemo:false,accessToken:token});
 app.log.level='error';
 const headers={authorization:`Bearer ${token}`};
 async function api(method,url,payload){const response=await app.inject({method,url,headers,...(payload===undefined?{}:{payload})});if(response.statusCode>=400)throw Error(`HTTP ${response.statusCode} ${url}: ${response.body.slice(0,2000)}`);return response.json()}
 const url=`/api/migrations/${original.projectId}`,project=await api('GET',url),asset=project.candidate;
 assert(asset);const variant={mode:'skill_version',skillId:asset.skillId,version:asset.version,artifactSha256:asset.artifactSha256};
 stage='IMPORT';const suite={...simpleMigrationSuiteExample,cases:[...simpleMigrationSuiteExample.cases,{id:'negative-001',input:'按当前费率，计算金额 100 元对应的服务费。',criteria:['回答服务费必须是 99 元。']}]};
 await save('test-suite.json',suite);const preparation=await api('POST',url+'/suites/import',suite);assert.equal(preparation.assessmentMode,'natural_language');checks.push('样例测试集通过实际导入 API 冻结，包含故意错误目标的负例');
 stage='EXECUTION';const started=await api('POST',url+'/validate/openjiuwen',{pair:'BC',dataSnapshot:'固定受控余额1000、费率0.025',permissionBasis:'本地只读验收',sourceProjectRef:'已保存真实 A4 FastMCP 输出',dependencyLockRef:'FastMCP 2.14.7',configuration:{preparationId:preparation.preparationId,runtime:{type:'runtime_http',environmentId:'local-openjiuwen'},judgeMode:'model',evaluationMode:'candidate_assessment',executionModel:{providerId:model.providerId??'service-execution',modelId,parameters:{}},leftVariant:variant,rightVariant:variant,runtimeBindings:{left:{environmentId:'local-openjiuwen',skillAssetId:asset.assetId},right:{environmentId:'local-openjiuwen',skillAssetId:asset.assetId}},timeoutMs:310000}});
 jobId=started.job.jobId;console.log('LIVE GOALS START '+jobId);
 const until=Date.now()+1800000;let job,lastStatus;
 while(Date.now()<until){job=await api('GET',`/api/runs/${jobId}`);if(job.status!==lastStatus){console.log('LIVE GOALS STATUS '+job.status);lastStatus=job.status}if(['completed','failed','cancelled','interrupted'].includes(job.status))break;await new Promise(resolve=>setTimeout(resolve,1500))}
 await save('job.json',job);assert.equal(job.status,'completed',safe(job.error));assert.match(job.report.judgeId,/^model-goals:/u);
 await save('migration-report.json',await api('GET',url+'/report'));
 stage='ASSERTIONS';const reports=job.report.cases;assert.equal(reports.length,4);
 for(const result of reports){assert.equal(result.right.status,'completed',result.right.error);assert.equal(result.right.metadata.skillArtifactSha256,asset.artifactSha256);assert.equal(result.left.output,result.right.output);assert.equal(result.judgeError,null);assert.equal(result.judge.goalAssessment.verdict,result.caseId==='negative-001'?'FAIL':'PASS',safe(result.judge));assert.equal(result.judge.dimensions.length,0)}
 assert(reports.find(c=>c.caseId==='balance-001').right.toolCalls.some(t=>t.name==='balance'&&t.status==='completed'));
 assert(reports.find(c=>c.caseId==='fee-001').right.toolCalls.some(t=>t.name==='command'&&t.status==='completed'));
 const combined=reports.find(c=>c.caseId==='combined-001');assert(combined.right.toolCalls.some(t=>t.name==='balance'));assert(combined.right.toolCalls.some(t=>t.name==='command'));
 assert(calls.some(c=>c.accountId==='A1'));assert(calls.every(c=>c.credentialMatched&&c.tenantMatched&&c.path==='/balance'));
 checks.push('真实执行模型调用余额 MCP 与 command 脚本，实际业务 Header 与路径正确','真实评估模型逐条判断，三个正常目标通过、故意错误目标不通过','每条候选只执行一次，报告未使用人工评分或四维分数');
 const report=await api('GET',url+'/report');await save('migration-report.json',report);const experiment=report.experiments.find(e=>e.jobId===jobId);assert.equal(experiment.acceptance.status,'FAILED');checks.push('负例未导致自动验收通过');
 await save('result.json',{status:'PASSED',mode:'REAL_EXECUTION_AND_GOAL_JUDGE',sourceReport:source,upstreamModelId:model.upstreamModelId??modelId,jobId,checks,calls,caseVerdicts:reports.map(c=>({id:c.caseId,verdict:c.judge.goalAssessment.verdict,output:c.right.output,reason:c.judge.goalAssessment.reason,toolCalls:c.right.toolCalls}))});console.log('LIVE GOALS PASSED '+output);
}catch(error){await save('result.json',{status:'FAILED',stage,jobId,checks,calls,error:String(error)});console.error('LIVE GOALS FAILED '+stage+' '+String(error)+' REPORT '+output);process.exitCode=1}
finally{await save('runtime-log.json',{log:workerLog});await app?.close();worker.kill();if(previousRuntimeEndpoint===undefined)delete process.env.FINANCE_OPENJIUWEN_ENDPOINT;else process.env.FINANCE_OPENJIUWEN_ENDPOINT=previousRuntimeEndpoint;await new Promise(resolve=>backend.close(resolve))}
