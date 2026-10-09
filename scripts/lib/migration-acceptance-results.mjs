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

// Do not copy raw provider errors, model configuration, prompts or connection-info.
export function acceptanceEntry({skillId, passed, provenance, cases = [], checks = [], phases = [], expectation = 'MIGRATED'}) {
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
  return {skillId,passed,expectation,provenance:Object.fromEntries(['diagnosis','generation','execution','judge'].map(k=>[k,provenance[k]])),cases:results,checks,phases};
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
  const closedLoop=real.filter(e=>['improvement','final-verification','adoption'].every(phase=>e.phases.includes(phase)));
  return {schemaVersion:1,runId,requestedSkills,entries,issues,passed,realModelAcceptancePassed,realModelScenarioAcceptancePassed,
    fullFiveSkillAcceptancePassed:issues.length===0 && legacyFiveSkills.every(id=>real.some(e=>e.skillId===id)),
    fullFiveSkillClosedLoopPassed:issues.length===0 && legacyFiveSkills.every(id=>closedLoop.some(e=>e.skillId===id)),
    fullExpandedScenarioAcceptancePassed:realModelScenarioAcceptancePassed && allSkills.every(id=>requestedSkills.includes(id)),
    expectedBlockedSkills:blocked.map(e=>e.skillId),migratedSkills:completed.filter(e=>e.expectation==='MIGRATED').map(e=>e.skillId),
    closedLoopSkills:closedLoop.map(e=>e.skillId),
    completedSkills:completed.map(e=>e.skillId),freshRealSkills:real.map(e=>e.skillId)};
}
