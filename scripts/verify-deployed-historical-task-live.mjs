// Append a real development run to an actual pre-upgrade frozen candidate.
// Historical candidate bytes, prior runs and held-out results are preserved.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
if(process.env.BUNDLE_LIVE_ENV_FILE)process.loadEnvFile(process.env.BUNDLE_LIVE_ENV_FILE);
const [baselineFile,outputDirectory]=process.argv.slice(2);assert(baselineFile&&outputDirectory);
const directory=path.resolve(outputDirectory);await mkdir(directory,{recursive:true});
const baseline=JSON.parse(await readFile(baselineFile,'utf8'));
const original=baseline.tasks.map(t=>t.task).find(t=>t.currentCandidateId&&t.runs.some(r=>r.phase==='holdout'&&r.status==='PASSED'));
assert(original,'Require a real pre-upgrade accepted task');
const service=process.env.BUNDLE_LIVE_SERVICE_URL.replace(/\/$/,''),headers={authorization:'Bearer '+process.env.FINANCE_EVAL_ACCESS_TOKEN,'content-type':'application/json'};
const report={status:'RUNNING',mode:'REAL_DEPLOYED_HISTORICAL_CANDIDATE',taskId:original.id,candidateId:original.currentCandidateId,serviceUrl:service};
const get=async()=>{const r=await fetch(service+'/api/migration-tasks/'+original.id,{headers});assert(r.ok);return r.json()};
const preserve=task=>{
  assert.equal(task.currentCandidateId,original.currentCandidateId);assert.deepEqual(task.candidates,original.candidates);
  assert.deepEqual(task.source,original.source);assert.deepEqual(task.configuration,original.configuration);assert.deepEqual(task.suite,original.suite);
  assert.deepEqual(task.runs.slice(0,original.runs.length),original.runs);assert.deepEqual(task.attempts.slice(0,original.attempts.length),original.attempts);
  assert.equal(task.runs.filter(r=>r.phase==='holdout').length,original.runs.filter(r=>r.phase==='holdout').length);
};
try{
  const before=await get();preserve(before);assert(!before.attempts.some(a=>a.status==='RUNNING'));
  const key='historical-live-'+randomUUID();
  const response=await fetch(service+'/api/migration-tasks/'+original.id+'/acceptance',{method:'POST',headers,body:JSON.stringify({key,baseCandidateId:original.currentCandidateId,phase:'development'})});
  assert.equal(response.status,202,await response.text());
  const deadline=Date.now()+20*60*1000;let task,attempt,last='';
  while(Date.now()<deadline){
    task=await get();attempt=task.attempts.find(a=>a.key===key);
    // The public record may call the idempotency field operationKey.
    attempt??=task.attempts.slice(before.attempts.length).find(a=>a.kind==='ACCEPT');
    if(attempt?.message!==last){last=attempt?.message;console.log(attempt?.status+' '+last);}
    if(attempt&&attempt.status!=='RUNNING')break;
    await new Promise(resolve=>setTimeout(resolve,1500));
  }
  assert.equal(attempt?.status,'COMPLETED',attempt?.error??'Historical acceptance timed out');preserve(task);
  const run=task.runs.find(r=>r.id===attempt.runId);assert.equal(run?.status,'PASSED',JSON.stringify(run?.cases.map(c=>({id:c.id,reason:c.reason}))));
  for(const c of run.cases){assert(c.passed&&c.evidence.runtimeIdentityVerified&&c.evidence.streamCompleted);assert.equal(c.evidence.loadedSkills.length,task.source.members.length);}
  assert(run.finalization.length===run.cases.length&&run.finalization.every(c=>c.status==='RELEASED'));
  await writeFile(path.join(directory,'task.json'),JSON.stringify(task,null,2));
  const exported=await fetch(service+'/api/migration-tasks/'+original.id+'/export?verified=true',{headers});assert.equal(exported.status,200);
  await writeFile(path.join(directory,'verified-historical.zip'),Buffer.from(await exported.arrayBuffer()));
  Object.assign(report,{status:'PASSED',runId:run.id,memberCount:task.source.members.length,development:run.cases.filter(c=>c.passed).length+'/'+run.cases.length,priorHistoryPreserved:true,holdoutReplayed:false,cleanup:'RELEASED'});
}catch(error){report.status='FAILED';report.error=error.message;process.exitCode=1;console.error('FAILED '+error.message);}
finally{report.finishedAt=new Date().toISOString();await writeFile(path.join(directory,'result.json'),JSON.stringify(report,null,2));}
