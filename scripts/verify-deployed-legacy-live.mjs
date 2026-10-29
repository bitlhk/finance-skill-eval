// Opt-in real v1 Runtime execution plus read/export checks of pre-upgrade tasks.
// Does not rewrite historical records or consume their held-out datasets.
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import path from 'node:path';
import {zipSync,unzipSync} from 'fflate';
import {RuntimeLauncherAdapter} from '../dist/runtime-launcher.js';
import {fingerprint,evalCaseSchema} from '../dist/contracts.js';
import {judgeBundleCase} from '../dist/migration/tasks/infrastructure/task-agent.js';
if(process.env.BUNDLE_LIVE_ENV_FILE)process.loadEnvFile(process.env.BUNDLE_LIVE_ENV_FILE);
const [baselineFile,outputDirectory]=process.argv.slice(2);
assert(baselineFile&&outputDirectory&&process.env.BUNDLE_LIVE_SERVICE_URL&&process.env.BUNDLE_LIVE_RUNTIME_URL);
const directory=path.resolve(outputDirectory);await mkdir(directory,{recursive:true});
const baseline=JSON.parse(await readFile(baselineFile,'utf8'));
const service=process.env.BUNDLE_LIVE_SERVICE_URL.replace(/\/$/,''),headers={authorization:'Bearer '+process.env.FINANCE_EVAL_ACCESS_TOKEN};
const checks=[];let runtime;
const report={status:'RUNNING',mode:'REAL_DEPLOYED_LEGACY_RUNTIME_AND_JUDGE',instanceProtocol:'finance.skill-eval.runtime-instance.v1',serviceUrl:service,checks};
const pass=name=>{checks.push(name);console.log('PASS '+name)};
try{
  for(const old of baseline.tasks){
    const response=await fetch(service+'/api/migration-tasks/'+old.id,{headers});assert.equal(response.status,200);
    const task=await response.json();assert.equal(fingerprint(task),fingerprint(old.task),'Historical task changed during upgrade');
    const alias=await fetch(service+'/api/migration-bundles/'+old.id,{headers}).then(r=>r.json());assert.deepEqual(alias,task);
    for(const m of task.source.members){
      const file=await fetch(service+'/api/migration-tasks/'+old.id+'/file?path='+encodeURIComponent(m.skillFile),{headers});assert.equal(file.status,200);
      assert((await file.json()).content);
    }
    const exported=await fetch(service+'/api/migration-tasks/'+old.id+'/export',{headers});
    if(!task.currentCandidateId){assert.equal(exported.status,409,'Unfinished historical task must not acquire a candidate');continue;}
    assert.equal(exported.status,200);
    const bytes=Buffer.from(await exported.arrayBuffer()),files=unzipSync(bytes);
    assert(files['migration/manifest.json']);
    for(const m of task.source.members)assert(files['package/'+m.skillFile]);
    await writeFile(path.join(directory,old.id+'.zip'),bytes);
  }
  assert(baseline.tasks.length>0,'Require actual historical deployed tasks');
  report.historicalTasks=baseline.tasks.map(t=>t.id);pass('historical_tasks_unchanged_readable_and_exportable_via_both_routes');
  const config=JSON.parse(await readFile(process.env.FINANCE_RUNTIME_CONFIG,'utf8'));
  const modelId=process.env.FINANCE_EVAL_AGENT_MODEL_ID??config.defaultModelId;
  const instructions='---\nname: legacy-policy\ndescription: Evaluate purchase amounts using the original policy.\n---\nUse this Skill to assess a purchase. Positive amounts at most 100 yuan are ALLOW; larger amounts are REJECT; missing or invalid amounts are UNAVAILABLE. Return an assessment only. Never approve, reserve, pay, or alter business records. Read references/policy.txt to confirm the legacy rule.';
  const files={'SKILL.md':instructions,'references/policy.txt':'Original policy: limit 100.00 yuan, equal is allowed. Assessment is not approval or payment.'};
  const archive=Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([p,v])=>[p,Buffer.from(v)]))));
  const digest=createHash('sha256').update(JSON.stringify(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)).map(([name,content])=>({content:Buffer.from(content).toString('base64'),name})))).digest('hex');
  const skill={skillId:'legacy-policy',version:'legacy-v1',artifactSha256:digest,instructions,files,archiveBase64:archive.toString('base64'),archiveSha256:createHash('sha256').update(archive).digest('hex')};
  const variant={mode:'skill_version',skillId:skill.skillId,version:skill.version,artifactSha256:digest};
  const model={providerId:'openjiuwen',modelId,parameters:{}};
  runtime=new RuntimeLauncherAdapter({baseUrl:process.env.BUNDLE_LIVE_RUNTIME_URL,side:'right',model,variant,skill,
    environment:{environmentId:'deployed-legacy-v1',harnessToolNames:['read_file','glob','list_files']},timeoutMs:600000});
  const runId='legacy-live-'+randomUUID();await runtime.prepare({runId});
  const evalCase=evalCaseSchema.parse({caseId:'legacy-equal-limit',name:'Legacy equal amount',prompt:'Activate legacy-policy using skill_tool, read references/policy.txt, and assess a purchase of 100.00 yuan. Give the decision and explain whether approval or payment occurred.',evaluationGoal:'Preserve the historical policy',requiredTools:[],rubric:[{criterionId:'policy',label:'Policy',description:'实际读取原规则，对 100.00 元判断 ALLOW，明确只是评估，未发生审批、预留或付款。',dimension:'business_completeness',weight:1}]});
  const evidence=await runtime.execute({runId,side:'right',evalCase,model,variant});
  await writeFile(path.join(directory,'v1-evidence.json'),JSON.stringify(evidence,null,2));
  assert.equal(evidence.status,'completed');assert(evidence.runtimeIdentityVerified&&evidence.streamCompleted);
  assert(evidence.toolCalls.some(c=>c.name==='skill_tool'&&c.status==='completed'));
  assert(evidence.metadata.referenceFilesRead['references/policy.txt']);pass('v1_archive_instance_loaded_and_executed_by_deployed_native_runtime');
  const verdict=await judgeBundleCase({evalCase,evidence,signal:AbortSignal.timeout(240000),correlation:{taskId:runId,runId}});
  await writeFile(path.join(directory,'v1-judge.json'),JSON.stringify(verdict,null,2));assert(verdict.passed,verdict.reason);
  pass('real_judge_accepted_legacy_policy');
  report.status='PASSED';
}catch(error){report.status='FAILED';report.error=error.message;process.exitCode=1;console.error('FAILED '+error.message);}
finally{
  if(runtime)try{await runtime.cleanup();report.cleanup=runtime.finalizationEvidence();assert.equal(report.cleanup.status,'RELEASED');}
  catch(error){report.status='FAILED';report.error=error.message;process.exitCode=1;}
  report.finishedAt=new Date().toISOString();await writeFile(path.join(directory,'result.json'),JSON.stringify(report,null,2));
}
