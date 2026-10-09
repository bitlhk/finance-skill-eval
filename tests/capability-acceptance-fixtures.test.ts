import {expect,it} from 'vitest';
import {readFile,readdir} from 'node:fs/promises';
// @ts-expect-error Acceptance data is not production code.
import {capabilitySkills,supplierSuite,ledgerSuite,ledgerFixture} from '../acceptance/capability-migration/manifest.mjs';

it('adds independent Skill sources and never includes holdouts in the uploaded source',async()=>{
  const names=[];
  for(const id of Object.keys(capabilitySkills)){
    const base=new URL(`../acceptance/capability-migration/${id}/source/`,import.meta.url);
    const source=await readFile(new URL('SKILL.md',base),'utf8');
    expect(source).toContain(`name: ${id}`);names.push(id);
    expect((await readdir(base,{recursive:true})).some(p=>/suite|holdout|manifest/.test(p))).toBe(false);
  }
  expect(new Set(names).size).toBe(3);
});

it('freezes ten unique behavioral cases across development and holdout splits',()=>{
  const cases=[...supplierSuite.cases,...supplierSuite.holdoutCases,...ledgerSuite.cases,...ledgerSuite.holdoutCases];
  expect(cases).toHaveLength(10);expect(new Set(cases.map((c:any)=>c.id)).size).toBe(10);
  expect(cases.every((c:any)=>c.input&&c.criteria.length)).toBe(true);
  expect(capabilitySkills['payment-exception'].expected).toBe('BLOCKED');
});

it('uses a genuinely large synthetic business response but exact decimal expectations',()=>{
  const response=ledgerFixture('AR-200');expect(response.items).toHaveLength(200);
  expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(256*1024);
  expect(ledgerFixture('AR-MISSING')).toBeUndefined();
  expect(ledgerFixture('constructor')).toBeUndefined();
  expect(ledgerFixture('AR-EMPTY').items).toEqual([]);
});
