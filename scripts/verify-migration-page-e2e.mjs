/** Browser migration E2E: real A2/A4, DeepAgent, original HTTP service and model Judge. Optional saved agent results must use identical source ZIP. */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {mkdir,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {zipSync,strToU8,unzipSync} from 'fflate';
import {createEvaluationService} from '../dist/service/server.js';
import {chromium,expect} from '@playwright/test';
import {analyzeWithAgent,implementWithAgent} from '../dist/service/migration-agent.js';

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
const report=path.join(root,'reports','migration-page-e2e-'+new Date().toISOString().replace(/[:.]/gu,'-'));
await mkdir(report,{recursive:true});
const work=await mkdtemp(path.join(os.tmpdir(),'original-service-comparison-'));
assert.equal(path.dirname(work),path.resolve(os.tmpdir()));
const python=path.join(root,'.venv-openjiuwen/Scripts/python.exe');
const token='controlled-baseline-secret';
const secrets=[token,...Object.values(originalConfig.models).map(value=>value.apiKey).filter(Boolean)];
async function save(name,value){let text=JSON.stringify(value,null,2);for(const secret of secrets)text=text.replaceAll(secret,'[redacted]');await writeFile(path.join(report,name),text)}
let app,worker,baseline,browser,page;const checks=[];const pass=name=>{checks.push(name);console.log('PASS '+name)};const audit=[];const previousToken=process.env.ORIGINAL_SERVICE_TEST_TOKEN;
const previousRuntimeConfig=process.env.FINANCE_RUNTIME_CONFIG,previousRuntimeEndpoint=process.env.FINANCE_OPENJIUWEN_ENDPOINT;
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
 process.env.FINANCE_RUNTIME_CONFIG=configFile;
 process.env.FINANCE_OPENJIUWEN_ENDPOINT=workerUrl+'/execute';
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
 console.log(savedA2?'Worker ready. Reusing real A2/A4 outputs for the same source.':'Worker ready. Running browser flow with real A2 and real A4.');
 app=await createEvaluationService({rootDirectory:root,dataDirectory:path.join(work,'data'),publicDemo:false,accessToken:'local-comparison-test',
  migrationAnalyzer:async input=>{const result=savedA2?JSON.parse(await readFile(path.join(savedA2,'a2-result.json'),'utf8')):await analyzeWithAgent(input,{projectRoot:root,modelId,providerId:model.providerId??'service-execution',timeoutMs:900000});await save('a2-result.json',result);return result},
  migrationImplementer:async input=>{const result=savedA2?JSON.parse(await readFile(path.join(savedA2,'a4-result.json'),'utf8')):await implementWithAgent(input,{projectRoot:root,modelId,providerId:model.providerId??'service-execution',timeoutMs:900000});await save('a4-result.json',result);return result}
  });
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

 const serviceUrl=await app.listen({host:'127.0.0.1',port:0});
 browser=await chromium.launch({channel:'msedge',headless:true});
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}});
 await context.tracing.start({screenshots:true,snapshots:true});
 page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 page.setDefaultTimeout(30000);
 page.on('dialog',dialog=>dialog.accept());
 await page.goto(serviceUrl);
 await page.getByLabel('访问令牌').fill('local-comparison-test');
 await page.getByRole('button',{name:'进入工作区',exact:true}).click();
 await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
 await page.getByRole('button',{name:'新建迁移',exact:true}).click();
 const inspectionResponse=page.waitForResponse(r=>r.url().endsWith('/inspect')&&r.request().method()==='POST',{timeout:900000});
 await page.locator('input[type=file]').first().setInputFiles({name:'document-harness.zip',mimeType:'application/zip',buffer:sourceZip});
 const inspected=await inspectionResponse;assert.ok(inspected.ok());
 await expect(page.getByRole('button',{name:'确认方案，进入生成',exact:true})).toBeEnabled({timeout:900000});
 await expect(page.locator('[data-runtime-capability="read_document"]')).toBeVisible();
 await page.screenshot({path:path.join(report,'01-diagnosis.png'),fullPage:true});pass('页面上传与真实A2诊断，识别原Harness');
 const projects=await api('GET','/api/migrations');const project=projects[0],url=`/api/migrations/${project.id}`;
 await save('inspection.json',await api('GET',url+'/report'));
 await page.getByRole('button',{name:'确认方案，进入生成',exact:true}).click();
 const generatedResponse=page.waitForResponse(r=>r.url().endsWith('/generate')&&r.request().method()==='POST',{timeout:900000});
 await page.getByRole('button',{name:'生成迁移后的 Skill 包',exact:true}).click();
 const generated=await (await generatedResponse).json();await save('candidate.json',generated);const candidate=generated.candidate;assert.ok(candidate,'A4 must deliver a candidate');
 await expect(page.getByRole('button',{name:'验证能否运行',exact:true})).toBeEnabled({timeout:900000});
 await page.screenshot({path:path.join(report,'02-candidate.png'),fullPage:true});pass('页面生成真实A4插件交付');
 await page.getByRole('button',{name:'验证能否运行',exact:true}).click();
 await page.getByRole('button',{name:'进入业务目标评估',exact:true}).click();
 await expect(page.getByLabel('原服务地址')).toHaveCount(0);
 await page.getByRole('button',{name:'提供测试集和目标',exact:true}).click();
 await expect(page.getByLabel('原服务地址')).toHaveCount(0);
 await page.getByRole('button',{name:'接入原服务做对比',exact:true}).click();
 await page.getByLabel('原服务地址').fill(baselineUrl);
 await page.getByLabel('请求 JSON 模板').fill('not json');
 await page.getByLabel('回答在哪个字段').fill('/data/result');
 await page.getByRole('button',{name:'添加请求头',exact:true}).click();
 await page.getByLabel('值所在的环境变量').fill('ORIGINAL_SERVICE_TEST_TOKEN');
 await page.getByLabel('查看或编辑测试集').fill(JSON.stringify({name:'页面文档对比',cases:[
 {id:'equivalent',input:'读取工作区 sample.txt 并告诉我文档内容和实现标记。',criteria:['文档内容为“迁移前后的内容必须一致。”，实现标记为 ORIGINAL_HARNESS_7F31。']},
 {id:'wrong-target',input:'读取工作区 sample.txt 并告诉我文档内容和实现标记。',criteria:['文档内容必须为“这个验收目标故意写错”。']}
 ]}));
 await page.getByRole('button',{name:'确认并导入',exact:true}).click();
 await expect(page.locator('label').filter({hasText:/^测试集请选择测试集/u}).locator('select')).not.toHaveValue('');
 await page.getByLabel('本地 Runtime').selectOption('local-openjiuwen');
 await expect(page.getByLabel('执行模型').locator('option')).not.toHaveCount(1);
 await page.getByLabel('执行模型').selectOption(modelId);
 await page.getByRole('button',{name:'执行两侧并自动对比',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'请求模板不是有效 JSON'})).toBeVisible();pass('无效请求模板页面拦截');
 await page.getByLabel('请求 JSON 模板').fill(JSON.stringify({request:{message:'{{input}}'},case_id:'{{caseId}}'}));
 await page.screenshot({path:path.join(report,'03-comparison-config.png'),fullPage:true});
 const runResponse=page.waitForResponse(r=>r.url().endsWith('/validate/openjiuwen')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'执行两侧并自动对比',exact:true}).click();
 const runHttp=await runResponse;assert.ok(runHttp.ok(),await runHttp.text());const experiment=await runHttp.json();
 pass('页面配置原接口映射、请求头与测试集，发起真实对比');
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

 await expect(page.getByText('1/2 条通过',{exact:true})).toBeVisible({timeout:30000});
 await expect(page.getByText('equivalent · 通过',{exact:true})).toBeVisible();
 await expect(page.getByText('wrong-target · 不通过',{exact:true})).toBeVisible();
 await page.screenshot({path:path.join(report,'04-comparison-results.png'),fullPage:true});pass('两侧实际执行及真实Judge：正例PASS，反例FAIL');
 await page.reload();
 await page.getByRole('button',{name:'Skill 迁移',exact:true}).click();
 await page.getByRole('button',{name:'继续处理',exact:true}).click();
 await page.getByRole('button',{name:'5 验证实际效果',exact:true}).click();
 await expect(page.getByLabel('原服务地址')).toHaveValue(baselineUrl);
 await expect(page.getByLabel('请求 JSON 模板')).toHaveValue(JSON.stringify({request:{message:'{{input}}'},case_id:'{{caseId}}'},null,2));
 await expect(page.getByText('1/2 条通过',{exact:true})).toBeVisible();pass('刷新后恢复原服务配置及对比结果');

 await page.getByRole('button',{name:'提供测试集和目标',exact:true}).click();
 await expect(page.getByLabel('原服务地址')).toHaveCount(0);
 await page.locator('label').filter({hasText:/^测试集请选择测试集/u}).locator('select').selectOption({index:1});
 await page.getByLabel('本地 Runtime').selectOption('local-openjiuwen');
 await page.getByLabel('执行模型').selectOption(modelId);
 const goalResponse=page.waitForResponse(r=>r.url().endsWith('/validate/openjiuwen')&&r.request().method()==='POST');
 await page.getByRole('button',{name:'执行并自动评估',exact:true}).click();
 const goalHttp=await goalResponse;assert.ok(goalHttp.ok(),await goalHttp.text());const goalExperiment=await goalHttp.json();
 console.log('Goal assessment executing through browser.');let goalJob;
 for(let attempt=0;attempt<900;attempt++){goalJob=await api('GET','/api/runs/'+goalExperiment.job.jobId);if(['completed','failed','cancelled','interrupted'].includes(goalJob.status))break;await new Promise(resolve=>setTimeout(resolve,1000))}
 await save('goal-job.json',goalJob);assert.equal(goalJob.status,'completed');
 for(const result of goalJob.report.cases){assert.equal(result.right.status,'completed');assert.equal(result.judge?.goalAssessment?.verdict,result.caseId==='equivalent'?'PASS':'FAIL');assert.ok(!result.judgeError)}
 await expect(page.getByText('1/2 条通过',{exact:true})).toHaveCount(2,{timeout:30000});
 await page.screenshot({path:path.join(report,'06-goal-results.png'),fullPage:true});pass('页面目标评估真实执行：正例PASS，反例FAIL');
 await page.getByRole('button',{name:'进入下载',exact:true}).click();
 await expect(page.getByRole('alert').filter({hasText:'当前候选尚未通过完整业务验收'})).toBeVisible();
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'下载迁移后的 Skill 包',exact:true}).click();
 const download=await pending;assert.ok(download.suggestedFilename().endsWith('-unverified.zip'));await download.saveAs(path.join(report,'candidate-unverified.zip'));
 const exported=unzipSync(await readFile(path.join(report,'candidate-unverified.zip')));assert.ok(Object.keys(exported).some(name=>name.startsWith('runtime-plugins/')&&name.endsWith('manifest.json')));
 await page.screenshot({path:path.join(report,'05-export.png'),fullPage:true});pass('页面导出未通过验收标记及实际插件文件');
 assert.deepEqual(errors,[]);pass('无浏览器脚本错误');await context.tracing.stop({path:path.join(report,'browser-trace.zip')});
 const outcome={passed:true,checks,scope:(savedA2?'Browser-driven import, reused real A2/A4 on identical source ZIP, ':'Browser-driven import, fresh real A2/A4, ')+'real original HTTP, real DeepAgent, real Judge, goal assessment, refresh and download; controlled credentials.',model:model.upstreamModelId??modelId,runtimeVersion:'0.1.17.post1',verdicts:job.report.cases.map(result=>({caseId:result.caseId,verdict:result.judge.serviceComparison.verdict})),report};await save('result.json',outcome);console.log(JSON.stringify(outcome));
}catch(error){if(page){await page.screenshot({path:path.join(report,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(path.join(report,'failure-page.txt'),await page.locator('body').innerText().catch(()=>''))}await save('result.json',{passed:false,error:String(error),report});console.error(String(error));process.exitCode=1}
finally{
 await browser?.close();await app?.close();if(baseline)await new Promise(resolve=>baseline.close(resolve));
 if(worker&&worker.exitCode===null){if(process.platform==='win32')await new Promise(resolve=>{const stop=spawn('taskkill',['/PID',String(worker.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});stop.once('close',resolve)});else worker.kill('SIGTERM')}
 if(previousToken===undefined)delete process.env.ORIGINAL_SERVICE_TEST_TOKEN;else process.env.ORIGINAL_SERVICE_TEST_TOKEN=previousToken;
 if(previousRuntimeConfig===undefined)delete process.env.FINANCE_RUNTIME_CONFIG;else process.env.FINANCE_RUNTIME_CONFIG=previousRuntimeConfig;
 if(previousRuntimeEndpoint===undefined)delete process.env.FINANCE_OPENJIUWEN_ENDPOINT;else process.env.FINANCE_OPENJIUWEN_ENDPOINT=previousRuntimeEndpoint;
 await rm(work,{recursive:true,force:true});
}
