import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { unzipSync } from 'fflate';
import { parse, stringify } from 'yaml';
import { createEvaluationService } from '../dist/service/server.js';

const input=process.argv[2],output=process.argv[3];
if(!input||!output)throw Error('Usage: node scripts/verify-private-migration-sample.mjs INPUT.zip PRIVATE_NEW_OUTPUT_DIRECTORY');
const root=path.resolve(output);await mkdir(root,{mode:0o700});
const original=await readFile(input),sourceZip=unzipSync(original);
const app=await createEvaluationService({rootDirectory:process.cwd(),dataDirectory:path.join(root,'data'),
  publicDirectory:path.join(root,'no-public-files'),accessToken:'isolated-sample-test',publicDemo:false});
const headers={authorization:'Bearer isolated-sample-test'};let requests=0;
const server=http.createServer((_req,res)=>{requests++;res.statusCode=500;res.end('No native Runtime configured');});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const post=async(url,payload)=>app.inject({url,method:'POST',headers,payload});
try {
 const upload=await app.inject({method:'POST',url:'/api/skills/upload',headers:{...headers,'content-type':'application/zip'},payload:original});
 assert.equal(upload.statusCode,200);const source=upload.json();
 const created=await post('/api/migrations',{sourceAssetId:source.assetId,name:'Private supplied sample - format-only verification'});
 assert.equal(created.statusCode,200);const id=created.json().id;
 const analysis=(await post(`/api/migrations/${id}/analyze`,{})).json();
 const text=analysis.source.startsWith('---\n')?analysis.source:'---\n'+analysis.source;
 const match=text.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);assert(match,'Metadata not safely recognized');
 const metadata=parse(match[1]);
 const draft=version=>`---\n${stringify({...metadata,version})}---\n${match[2]}`;
 let base=source.assetId,candidate;
 for(const version of ['0.1.0-format-candidate','0.1.1-format-candidate']){
  const edit=await post(`/api/migrations/${id}/drafts`,{baseAssetId:base,source:draft(version),notes:'Format/version only; no business method or dependency was repaired.'});
  assert.equal(edit.statusCode,200);candidate=edit.json().candidate;base=candidate.assetId;
 }
 const rubric=[{criterionId:'missing',label:'Missing is not zero',description:'Do not invent facts',dimension:'business_completeness',weight:1,required:true,allOf:['缺失']}];
 const makeCase=(caseId,prompt)=>({caseId,name:caseId,prompt,evaluationGoal:'Proposed synthetic missing-data case; business owner review pending',rubric,requiredTools:[]});
 const suite=await post(`/api/migrations/${id}/suites`,{summary:'Supplied sample: proposed missing-data development/holdout',
  cases:[makeCase('DEV-MISSING','只读核验合成客户借款资料；来源未提供，不把缺失记为零。')],
  holdoutCases:[makeCase('HOLDOUT-MISSING','另一个合成客户的关键资料不可用，列明无法判断的项目。')]});
 assert.equal(suite.statusCode,200);
 const env=await post('/api/environments',{name:'Unconnected Runtime Launcher probe',type:'runtime_launcher',runtimeType:'generic_http',
  baseUrl:`http://127.0.0.1:${server.address().port}/`});assert.equal(env.statusCode,200);
 const variant=a=>({mode:'skill_version',skillId:a.skillId,version:a.version,artifactSha256:a.artifactSha256});
 const environmentId=env.json().environmentId;
 const run=await post(`/api/migrations/${id}/validate`,{pair:'AB',dataSnapshot:'NOT_AVAILABLE',permissionBasis:'SYNTHETIC_ONLY_NOT_NATIVE_AUTHORIZATION',
  sourceProjectRef:'MISSING_ORIGINAL_ENGINEERING',dependencyLockRef:'MISSING',configuration:{preparationId:suite.json().preparationId,
  runtime:{type:'runtime_launcher',environmentId},executionModel:{providerId:'synthetic',modelId:'not-invoked'},judgeMode:'deterministic',
  leftVariant:variant(source),rightVariant:variant(candidate),runtimeBindings:{left:{environmentId,skillAssetId:source.assetId},right:{environmentId,skillAssetId:candidate.assetId}}}});
 assert.equal(run.statusCode,200);const jobId=run.json().job.jobId;
 let job;
 for(let n=0;n<100;n++){job=(await app.inject({url:`/api/runs/${jobId}`,headers})).json();if(['failed','completed','cancelled'].includes(job.status))break;await new Promise(r=>setTimeout(r,50));}
 assert.equal(job.status,'failed');assert.match(job.error.message,/dependency mapping required/i);assert.equal(requests,0);
 assert.equal((await post(`/api/migrations/${id}/optimize`,{jobId})).statusCode,409);
 assert.equal((await post(`/api/migrations/${id}/releases`,{})).statusCode,409);
 const exported=await app.inject({url:`/api/migrations/${id}/export`,headers});assert.equal(exported.statusCode,200);
 const files=unzipSync(exported.rawPayload),manifest=JSON.parse(Buffer.from(files['migration-manifest.json']).toString());
 for(const [name,bytes] of Object.entries(sourceZip)){
  if(name.endsWith('/'))continue;assert(files[name],`Missing exported file ${name}`);
  if(name!==source.skillFile)assert.deepEqual(files[name],bytes);
  assert.equal(createHash('sha256').update(files[name]).digest('hex'),manifest.files[name]);
 }
 assert.equal(manifest.state,'DRAFT_NOT_VALIDATED');assert.equal(manifest.dependencies,'NOT_VALIDATED');
 const stored=(await app.inject({url:`/api/migrations/${id}`,headers})).json();assert.deepEqual(stored.source,source);
 await writeFile(path.join(root,'candidate-draft.zip'),exported.rawPayload,{mode:0o600,flag:'wx'});
 await writeFile(path.join(root,'result.json'),JSON.stringify({mode:'PRIVATE_PACKAGE_WORKFLOW_NOT_NATIVE_EXECUTION',
  inputZipSha256:createHash('sha256').update(original).digest('hex'),projectId:id,sourceAssetId:source.assetId,candidateAssetId:candidate.assetId,
  checks:{import:'PASS',twoVersionEdits:'PASS',sourceImmutable:'PASS',customSuiteFrozen:'PASS',reevaluation:'BLOCKED_MISSING_DEPENDENCIES',
   failedRunOptimization:'REJECTED_AS_EXPECTED',completeExport:'PASS',unchangedDependencyBytes:'PASS',fileDigests:'PASS',release:'BLOCKED'},
  outgoingRuntimeRequests:requests,scriptsExecuted:0,realModelsInvoked:0,nativeMigration:'NOT_VALIDATED',businessAcceptance:'NOT_RUN'},null,2),{mode:0o600,flag:'wx'});
 console.log('Private package workflow verified. Native migration remains unvalidated. Results saved in the chosen private directory.');
} finally {await app.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
