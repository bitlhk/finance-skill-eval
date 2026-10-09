import {expect,it} from 'vitest';
// @ts-expect-error Test orchestration is deliberately outside the production bundle.
import {acceptanceEntry,allSkills,legacyFiveSkills,selectedEnterpriseCases,summarizeAcceptance} from '../scripts/lib/migration-acceptance-results.mjs';

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
it('reports a selected subset honestly without claiming all five',()=>{
  const requested=allSkills.slice(0,2);
  expect(summary(requested.map((id:string)=>entry(id)),{requestedSkills:requested})).toMatchObject({realModelAcceptancePassed:true,fullFiveSkillAcceptancePassed:false});
});
it('does not confuse migration acceptance with a verified improvement and adoption loop',()=>{
  const entries=allSkills.map((id:string)=>entry(id));
  expect(summary(entries)).toMatchObject({fullFiveSkillAcceptancePassed:true,fullFiveSkillClosedLoopPassed:false});
  for(const value of entries)if(value.expectation==='MIGRATED')value.phases=['improvement','final-verification','adoption'];
  expect(summary(entries).fullFiveSkillClosedLoopPassed).toBe(true);
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
