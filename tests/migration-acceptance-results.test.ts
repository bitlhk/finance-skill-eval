import {expect,it} from 'vitest';
// @ts-expect-error Test orchestration is deliberately outside the production bundle.
import {acceptanceEntry,allSkills,legacyFiveSkills,selectedEnterpriseCases,summarizeAcceptance,verifiedDeliveryEvidence,verifiedHarnessRebuildEvidence} from '../scripts/lib/migration-acceptance-results.mjs';

const entry=(skillId:string,change:Record<string,unknown>={})=>acceptanceEntry({skillId,passed:true,
  provenance:{diagnosis:'REAL',generation:'REAL',execution:'REAL',judge:'REAL'},cases:[{caseId:'actual-case',verdict:'PASS'}],
  ...(skillId==='payment-exception'?{expectation:'BLOCKED',provenance:{diagnosis:'REAL',generation:'REAL',execution:'NOT_RUN',judge:'NOT_RUN'},
    checks:['partial_native_match_rejected','complete_builder_requirements_exported','no_fake_runtime_binding'],phases:['expected-block']}:{}),...change});
const summary=(entries:any[],extra:Record<string,unknown>={})=>summarizeAcceptance({runId:'this-run',requestedSkills:allSkills,
  children:[{exitCode:0,result:{schemaVersion:1,runId:'this-run',entries}}],...extra});

it('counts actual fresh real Skill results, never the length of a static list',()=>{
  expect(summary(allSkills.map((id:string)=>entry(id))).fullFiveSkillAcceptancePassed).toBe(true);
  expect(summary([entry(allSkills[0])]).fullFiveSkillAcceptancePassed).toBe(false);
});
it.each(['STUBBED','REUSED_REAL','NOT_RUN'])('does not claim fresh real acceptance with %s evidence',mode=>{
  const entries=allSkills.map((id:string)=>entry(id));entries[0].provenance.generation=mode;
  expect(summary(entries)).toMatchObject({passed:true,realModelAcceptancePassed:false,fullFiveSkillAcceptancePassed:false});
});
it('keeps continued, failed and stubbed results in separate accounts',()=>{
 const continued=entry(allSkills[0],{provenance:{diagnosis:'REAL',generation:'REUSED_REAL',execution:'REAL',judge:'REAL'}});
 const failed=entry(allSkills[1],{passed:false,cases:[{caseId:'failure',verdict:'FAIL'}]});
 const stubbed=entry(allSkills[2],{provenance:{diagnosis:'STUBBED',generation:'STUBBED',execution:'STUBBED',judge:'STUBBED'}});
 const result=summary([continued,failed,stubbed],{requestedSkills:allSkills.slice(0,3)});
 expect(result.continuedRealSkills).toEqual([allSkills[0]]);expect(result.failedSkills).toEqual([allSkills[1]]);expect(result.stubbedSkills).toEqual([allSkills[2]]);
 expect(result.closedLoopSkills).toEqual([]);expect(result.fullExpandedScenarioAcceptancePassed).toBe(false);
});
it('reports a selected subset honestly without claiming all five',()=>{
  const requested=allSkills.slice(0,2);
  expect(summary(requested.map((id:string)=>entry(id)),{requestedSkills:requested})).toMatchObject({realModelAcceptancePassed:true,fullFiveSkillAcceptancePassed:false});
});
it('does not confuse migration acceptance with a verified improvement and adoption loop',()=>{
  const entries=allSkills.map((id:string)=>entry(id));
  expect(summary(entries)).toMatchObject({fullFiveSkillAcceptancePassed:true,fullFiveSkillClosedLoopPassed:false});
  for(const value of entries)if(value.expectation==='MIGRATED')value.phases=['improvement','final-verification','adoption'];
  expect(summary(entries).fullFiveSkillClosedLoopPassed).toBe(false);
  for(const value of entries)if(value.expectation==='MIGRATED'){
    value.phases=['migration','technical','improvement','final-verification','adoption','reuse-acceptance','verified-export'];
    value.deliveryEvidence={candidateDigest:'a'.repeat(64),configurationDigest:'b'.repeat(64),verifiedExportDigest:'a'.repeat(64),
      proposalId:'proposal',finalJobId:'final',reuseTaskId:'reuse',reuseJobIds:['reuse-run']};
  }
  expect(summary(entries).fullFiveSkillClosedLoopPassed).toBe(true);
  delete entries[0].deliveryEvidence;
  expect(summary(entries).fullFiveSkillClosedLoopPassed).toBe(false);
});

function closureFixture(){
 const hash='a'.repeat(64),config='b'.repeat(64);
 return {report:{project:{candidate:{artifactSha256:hash}},migrationPlan:{reuseProposal:{proposalId:'proposal',approvedAt:'now'}},
  verification:{targetExecution:'PASSED',reuseAcceptance:'PASSED',delivery:{status:'VERIFIED'}},
  experiments:[{jobId:'final',current:true,runtimeConfigurationDigest:config,acceptance:{status:'PASSED'}}]},
  task:{status:'ADOPTED',finalConsumed:true,finalVerified:true,finalJobId:'final',bestCandidate:{artifactSha256:hash}},
  reuse:{status:'PASSED',current:true,result:{status:'PASSED',taskId:'reuse',checks:[{status:'PASSED'}],jobs:[{jobId:'reuse-run'}],
   binding:{candidateDigest:hash,proposalId:'proposal',configurationDigest:config}}},exportDigest:hash};
}

function rebuildFixture(){
 const hash='a'.repeat(64),config='b'.repeat(64);
 const req={requirementsDigest:'req',source:{artifactSha256:hash},rebuild:{baseline:{artifactSha256:'old-artifact',deploymentId:'old-deployment'}}};
 const waitingTask={taskId:'one-task',sourceJobId:'baseline',status:'WAITING_BUILDER',runtimeRequirements:req};
 const task={...waitingTask,status:'ADOPTED',baseCandidateDigest:hash,runtimeRequirements:req,configurationDigest:config,
  finalConsumed:true,finalVerified:true,finalJobId:'final',bestJobId:'resumed',bestCandidate:{artifactSha256:hash},
  contextChanges:[{environmentId:'new-env'}],iterations:[{layer:'HARNESS',outcome:'PROMOTED',jobId:'resumed',passed:2,total:2}]};
 const report={project:{candidate:{artifactSha256:hash},runtimeDelivery:{requirementsDigest:'req',environmentId:'new-env',artifactSha256:'new-artifact',deploymentId:'new-deployment'}},
  verification:{targetExecution:'PASSED'},experiments:[{jobId:'baseline',acceptance:{status:'FAILED'}},
   ...['resumed','final'].map(jobId=>({jobId,current:true,runtimeConfigurationDigest:config,acceptance:{status:'PASSED'}}))]};
 return {report,waitingTask,task};
}
it('requires the same task to wait for Builder, resume, verify holdout and adopt',()=>{
 const f=rebuildFixture();expect(verifiedHarnessRebuildEvidence(f)).toMatchObject({taskId:'one-task',resumedJobId:'resumed',finalJobId:'final'});
 for(const change of [
  (v:any)=>{v.task.taskId='later-passing-task'},(v:any)=>{v.task.finalVerified=false},
  (v:any)=>{v.waitingTask.status='FAILED'},(v:any)=>{v.task.iterations=[]},
  (v:any)=>{v.task.contextChanges=[]},(v:any)=>{v.report.project.runtimeDelivery.requirementsDigest='other'},
  (v:any)=>{v.report.project.runtimeDelivery.artifactSha256='old-artifact'},
  (v:any)=>{v.report.project.runtimeDelivery.deploymentId='old-deployment'},
  (v:any)=>{v.report.experiments[2].current=false},(v:any)=>{v.report.experiments[2].acceptance.status='FAILED'},
  (v:any)=>{v.report.experiments[2].runtimeConfigurationDigest='other'},
 ]){const input=rebuildFixture();change(input);expect(()=>verifiedHarnessRebuildEvidence(input)).toThrow();}
});
it('binds closed-loop evidence to current approved, adopted, business/reuse-tested and exported identity',()=>{
 const f=closureFixture();expect(verifiedDeliveryEvidence(f)).toMatchObject({candidateDigest:f.exportDigest,reuseTaskId:'reuse',finalJobId:'final'});
 for(const mutate of [
  (v:any)=>{v.reuse.current=false},(v:any)=>{v.reuse.result.binding.candidateDigest='c'.repeat(64)},
  (v:any)=>{v.reuse.result.binding.proposalId='other'},(v:any)=>{v.reuse.result.binding.configurationDigest='c'.repeat(64)},
  (v:any)=>{v.report.verification.delivery.status='UNVERIFIED'},(v:any)=>{v.report.experiments[0].current=false},
  (v:any)=>{v.task.status='REVIEW'},(v:any)=>{v.task.finalVerified=false},(v:any)=>{v.exportDigest='c'.repeat(64)},
  (v:any)=>{v.reuse.result.checks=[]},(v:any)=>{v.reuse.result.jobs=[]},(v:any)=>{v.reuse.result.jobs.push({jobId:'reuse-run'})},
 ]){const input=closureFixture();mutate(input);expect(()=>verifiedDeliveryEvidence(input)).toThrow();}
 const withPrivate={...verifiedDeliveryEvidence(f),apiKey:'PRIVATE',url:'PRIVATE',raw:'PRIVATE'};
 expect(JSON.stringify(entry(allSkills[0],{deliveryEvidence:withPrivate}))).not.toContain('PRIVATE');
});
it('rejects duplicates, missing results, stale run IDs, child failures and vacuous passes',()=>{
  expect(summary([...allSkills.map((id:string)=>entry(id)),entry(allSkills[0])]).passed).toBe(false);
  for(const child of [{exitCode:0},{exitCode:1,result:{schemaVersion:1,runId:'this-run',entries:allSkills.map((id:string)=>entry(id))}},
    {exitCode:0,result:{schemaVersion:1,runId:'old-run',entries:allSkills.map((id:string)=>entry(id))}}])
    expect(summary([],{children:[child]}).passed).toBe(false);
  expect(()=>entry(allSkills[0],{cases:[]})).toThrow();
  expect(()=>entry(allSkills[0],{cases:[{caseId:'bad',verdict:'FAIL'}]})).toThrow();
});
it('validates the enterprise subset before spending model calls',()=>{
  expect(selectedEnterpriseCases(undefined)).toHaveLength(4);
  expect(selectedEnterpriseCases('01-expense, 04-refund')).toEqual(['01-expense','04-refund']);
  for(const value of ['', '01-expense,01-expense','unknown'])expect(()=>selectedEnterpriseCases(value)).toThrow();
});
it('drops non-summary data, including credentials and raw errors',()=>{
  const result=entry(allSkills[0],{apiKey:'PRIVATE',error:'PRIVATE',provenance:{diagnosis:'REAL',generation:'REAL',execution:'REAL',judge:'REAL',apiKey:'PRIVATE'}});
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
});

it('distinguishes expected blocking from successful migration and keeps legacy-five semantics',()=>{
  expect(allSkills).toHaveLength(8);
  const result=summary(allSkills.map((id:string)=>entry(id)));
  expect(result).toMatchObject({passed:true,realModelAcceptancePassed:false,realModelScenarioAcceptancePassed:true,fullExpandedScenarioAcceptancePassed:true,fullFiveSkillAcceptancePassed:true});
  expect(result.migratedSkills).not.toContain('payment-exception');
  expect(result.expectedBlockedSkills).toEqual(['payment-exception']);
  expect(summary(legacyFiveSkills.map((id:string)=>entry(id)),{requestedSkills:legacyFiveSkills})).toMatchObject({fullFiveSkillAcceptancePassed:true,fullExpandedScenarioAcceptancePassed:false});
  expect(()=>entry('payment-exception',{expectation:'MIGRATED'})).toThrow();
  expect(()=>entry('payment-exception',{checks:[]})).toThrow();
  expect(()=>entry('payment-exception',{provenance:{diagnosis:'REAL',generation:'REAL',execution:'REAL',judge:'REAL'}})).toThrow();
});
