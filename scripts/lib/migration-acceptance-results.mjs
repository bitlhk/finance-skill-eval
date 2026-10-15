import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {capabilitySkills} from '../../acceptance/capability-migration/manifest.mjs';

export const enterpriseSkills = Object.freeze({
  '01-expense':'expense-compliance', '02-balance':'employee-balance',
  '03-procurement':'procurement-review', '04-refund':'refund-eligibility',
});
export const legacyFiveSkills = Object.freeze(['openjiuwen-portability-acceptance', ...Object.values(enterpriseSkills)]);
export const allSkills = Object.freeze([...legacyFiveSkills, ...Object.keys(capabilitySkills)]);

export function selectedEnterpriseCases(value) {
  const selected = value === undefined ? Object.keys(enterpriseSkills) : value.split(',').map(s=>s.trim());
  assert(selected.length && new Set(selected).size === selected.length, 'Empty or duplicate enterprise selection');
  assert(selected.every(id=>Object.hasOwn(enterpriseSkills,id)), 'Unknown enterprise selection');
  return selected;
}

const closedLoopPhases = ['migration','technical','improvement','final-verification','adoption','reuse-acceptance','verified-export'];
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function validatedDeliveryEvidence(value) {
  assert(value && typeof value === 'object', 'Missing delivery evidence');
  for (const key of ['candidateDigest','configurationDigest','verifiedExportDigest']) assert(digest(value[key]), `Invalid ${key}`);
  assert.equal(value.verifiedExportDigest,value.candidateDigest,'Export must be the accepted candidate');
  for (const key of ['proposalId','finalJobId','reuseTaskId']) assert(typeof value[key]==='string'&&value[key].length>0, `Missing ${key}`);
  assert(Array.isArray(value.reuseJobIds)&&value.reuseJobIds.length>0&&value.reuseJobIds.every(id=>typeof id==='string'&&id.length>0));
  assert.equal(new Set(value.reuseJobIds).size,value.reuseJobIds.length,'Duplicate reuse jobs');
  return Object.fromEntries(['proposalId','candidateDigest','configurationDigest','finalJobId','reuseTaskId','reuseJobIds','verifiedExportDigest'].map(key=>[key,value[key]]));
}

/** Build closure only from current service read models and the actual export response. */
export function verifiedDeliveryEvidence({report,reuse,task,exportDigest}) {
  const candidateDigest=report.project.candidate?.artifactSha256,proposal=report.migrationPlan?.reuseProposal;
  assert(digest(candidateDigest)&&proposal?.approvedAt,'Current candidate and approved proposal required');
  assert.equal(report.verification.delivery.status,'VERIFIED','Delivery checks are not complete');
  assert.equal(report.verification.targetExecution,'PASSED');
  assert.equal(report.verification.reuseAcceptance,'PASSED');
  assert.equal(reuse.status,'PASSED');assert.equal(reuse.current,true);
  assert.equal(reuse.result.status,'PASSED');assert(reuse.result.checks.length&&reuse.result.checks.every(c=>c.status==='PASSED'));
  assert.equal(reuse.result.binding.candidateDigest,candidateDigest);
  assert.equal(reuse.result.binding.proposalId,proposal.proposalId);
  assert.equal(task.status,'ADOPTED');assert(task.finalVerified&&task.finalConsumed);
  assert.equal(task.bestCandidate.artifactSha256,candidateDigest);
  const final=report.experiments.find(e=>e.jobId===task.finalJobId);
  assert(final?.current&&final.acceptance.status==='PASSED','Current final verification required');
  assert.equal(final.runtimeConfigurationDigest,reuse.result.binding.configurationDigest);
  return validatedDeliveryEvidence({proposalId:proposal.proposalId,candidateDigest,
    configurationDigest:reuse.result.binding.configurationDigest,finalJobId:task.finalJobId,
    reuseTaskId:reuse.result.taskId,reuseJobIds:reuse.result.jobs.map(j=>j.jobId),verifiedExportDigest:exportDigest});
}

/** One task must span the external rebuild and adoption. A later passing task
 * cannot replace a failed holdout from the task that requested the rebuild. */
export function verifiedHarnessRebuildEvidence({report,waitingTask,task}) {
  assert.equal(waitingTask.status,'WAITING_BUILDER','Missing observed Builder wait');
  assert.equal(task.taskId,waitingTask.taskId,'Rebuild and adoption must use the same task');
  assert.equal(task.sourceJobId,waitingTask.sourceJobId);
  assert.equal(task.status,'ADOPTED');assert(task.finalConsumed&&task.finalVerified);
  const requirements=waitingTask.runtimeRequirements,delivery=report.project.runtimeDelivery;
  assert(requirements?.rebuild?.baseline&&delivery,'Missing rebuild requirements or admitted delivery');
  assert.equal(task.runtimeRequirements?.requirementsDigest,requirements.requirementsDigest);
  assert.equal(delivery.requirementsDigest,requirements.requirementsDigest);
  assert.equal(requirements.source.artifactSha256,task.baseCandidateDigest);
  assert.notEqual(delivery.artifactSha256,requirements.rebuild.baseline.artifactSha256);
  assert.notEqual(delivery.deploymentId,requirements.rebuild.baseline.deploymentId);
  assert(task.contextChanges?.some(c=>c.environmentId===delivery.environmentId),'Missing task resumption with admitted deployment');
  const promoted=task.iterations?.find(i=>i.layer==='HARNESS'&&i.outcome==='PROMOTED'&&i.jobId===task.bestJobId);
  assert(promoted?.total>0&&promoted.passed===promoted.total,'No verified development improvement');
  const baseline=report.experiments.find(e=>e.jobId===task.sourceJobId);
  assert(baseline&&baseline.acceptance.status!=='PASSED','Missing failing baseline');
  for(const jobId of [promoted.jobId,task.finalJobId]){
    const run=report.experiments.find(e=>e.jobId===jobId);
    assert(run?.current&&run.acceptance.status==='PASSED','Missing current resumed/final verification');
    assert.equal(run.runtimeConfigurationDigest,task.configurationDigest);
  }
  assert.equal(report.project.candidate?.artifactSha256,task.bestCandidate.artifactSha256);
  assert.equal(report.verification.targetExecution,'PASSED');
  return {taskId:task.taskId,sourceJobId:task.sourceJobId,requirementsDigest:requirements.requirementsDigest,
    deploymentId:delivery.deploymentId,artifactSha256:delivery.artifactSha256,
    resumedJobId:promoted.jobId,finalJobId:task.finalJobId,candidateDigest:task.bestCandidate.artifactSha256};
}

// Do not copy raw provider errors, model configuration, prompts or connection-info.
export function acceptanceEntry({skillId, passed, provenance, cases = [], checks = [], phases = [], expectation = 'MIGRATED',deliveryEvidence}) {
  assert(allSkills.includes(skillId), 'Unknown Skill');
  assert.equal(expectation,capabilitySkills[skillId]?.expected??'MIGRATED','Unexpected acceptance objective');
  assert(typeof passed === 'boolean');
  for(const role of ['diagnosis','generation','execution','judge'])
    assert(['REAL','REUSED_REAL','STUBBED','NOT_RUN'].includes(provenance[role]), `Invalid provenance: ${role}`);
  assert(new Set(cases.map(c=>c.caseId)).size === cases.length, 'Duplicate case results');
  const results=cases.map(c=>{
    assert(typeof c.caseId==='string' && c.caseId.length>0 && c.caseId.length<=200);
    assert(['PASS','FAIL','INDETERMINATE','UNKNOWN'].includes(c.verdict));
    return {caseId:c.caseId,verdict:c.verdict};
  });
  assert(!passed || (results.length>0 && results.every(c=>c.verdict==='PASS')), 'A pass requires actual passing case results');
  assert(checks.every(s=>typeof s==='string') && phases.every(s=>typeof s==='string'));
  if(expectation==='BLOCKED'){
    assert(provenance.execution==='NOT_RUN'&&provenance.judge==='NOT_RUN','Blocked acceptance must not claim execution');
    assert(!passed||(['partial_native_match_rejected','complete_builder_requirements_exported','no_fake_runtime_binding'].every(c=>checks.includes(c))&&phases.includes('expected-block')),'Missing blocking evidence');
  }
  const evidence=deliveryEvidence===undefined?undefined:validatedDeliveryEvidence(deliveryEvidence);
  assert(!evidence||expectation==='MIGRATED','Blocked scenarios cannot claim verified delivery');
  return {skillId,passed,expectation,provenance:Object.fromEntries(['diagnosis','generation','execution','judge'].map(k=>[k,provenance[k]])),cases:results,checks,phases,...(evidence?{deliveryEvidence:evidence}:{})};
}

export async function writeAcceptanceResult(entries) {
  if(!process.env.MIGRATION_ACCEPTANCE_RESULT) return;
  assert(process.env.MIGRATION_ACCEPTANCE_RUN_ID, 'Missing acceptance run identity');
  await writeFile(process.env.MIGRATION_ACCEPTANCE_RESULT, JSON.stringify({schemaVersion:1,
    runId:process.env.MIGRATION_ACCEPTANCE_RUN_ID,entries:entries.map(acceptanceEntry)},null,2)+'\n', {flag:'wx'});
}

export function summarizeAcceptance({runId, requestedSkills, children}) {
  assert(requestedSkills.length && new Set(requestedSkills).size===requestedSkills.length);
  assert(requestedSkills.every(id=>allSkills.includes(id)));
  const entries=[],issues=[];
  for(const child of children) {
    if(child.exitCode!==0) issues.push('CHILD_FAILED');
    if(!child.result) {issues.push('MISSING_RESULT');continue;}
    if(child.result.schemaVersion!==1 || child.result.runId!==runId) {issues.push('STALE_OR_INVALID_RESULT');continue;}
    try {assert(Array.isArray(child.result.entries));entries.push(...child.result.entries.map(acceptanceEntry));}
    catch {issues.push('INVALID_ENTRY');}
  }
  for(const id of requestedSkills) if(entries.filter(e=>e.skillId===id).length!==1) issues.push(`MISSING_OR_DUPLICATE:${id}`);
  if(entries.some(e=>!requestedSkills.includes(e.skillId))) issues.push('UNREQUESTED_RESULT');
  const completed=entries.filter(e=>e.passed);
  const real=completed.filter(e=>e.expectation==='MIGRATED'&&Object.values(e.provenance).every(v=>v==='REAL'));
  const blocked=completed.filter(e=>e.expectation==='BLOCKED'&&e.provenance.diagnosis==='REAL'&&e.provenance.generation==='REAL');
  const passed=issues.length===0 && completed.length===requestedSkills.length;
  const realModelAcceptancePassed=passed && real.length===requestedSkills.length;
  const realModelScenarioAcceptancePassed=passed && real.length+blocked.length===requestedSkills.length;
  const closedLoop=real.filter(e=>e.deliveryEvidence&&closedLoopPhases.every(phase=>e.phases.includes(phase)));
  return {schemaVersion:1,runId,requestedSkills,entries,issues,passed,realModelAcceptancePassed,realModelScenarioAcceptancePassed,
    fullFiveSkillAcceptancePassed:issues.length===0 && legacyFiveSkills.every(id=>real.some(e=>e.skillId===id)),
    fullFiveSkillClosedLoopPassed:issues.length===0 && legacyFiveSkills.every(id=>closedLoop.some(e=>e.skillId===id)),
    fullExpandedScenarioAcceptancePassed:realModelScenarioAcceptancePassed && allSkills.every(id=>requestedSkills.includes(id)),
    expectedBlockedSkills:blocked.map(e=>e.skillId),migratedSkills:completed.filter(e=>e.expectation==='MIGRATED').map(e=>e.skillId),
    closedLoopSkills:closedLoop.map(e=>e.skillId),
    completedSkills:completed.map(e=>e.skillId),freshRealSkills:real.map(e=>e.skillId),
    continuedRealSkills:completed.filter(e=>Object.values(e.provenance).includes('REUSED_REAL')&&Object.values(e.provenance).every(v=>['REAL','REUSED_REAL','NOT_RUN'].includes(v))).map(e=>e.skillId),
    failedSkills:entries.filter(e=>!e.passed).map(e=>e.skillId),
    stubbedSkills:entries.filter(e=>Object.values(e.provenance).includes('STUBBED')).map(e=>e.skillId)};
}
