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

it('freezes twelve unique behavioral cases across development and holdout splits',()=>{
  const cases=[...supplierSuite.cases,...supplierSuite.holdoutCases,...ledgerSuite.cases,...ledgerSuite.holdoutCases];
  expect(cases).toHaveLength(12);expect(new Set(cases.map((c:any)=>c.id)).size).toBe(12);
  expect(ledgerSuite.cases.map((c:any)=>c.id)).toContain('ledger-selected');
  expect(ledgerSuite.holdoutCases.map((c:any)=>c.id)).toContain('ledger-unknown-invoice');
  expect(cases.every((c:any)=>c.input&&c.criteria.length)).toBe(true);
  expect(capabilitySkills['payment-exception'].expected).toBe('BLOCKED');
});

it('exposes business query and snapshot consumption, never server lifecycle tools',async()=>{
  const base=new URL('../acceptance/capability-migration/receivables-ledger/source/',import.meta.url);
  const [skill,register]=await Promise.all(['SKILL.md','tools/register.py'].map(file=>readFile(new URL(file,base),'utf8')));
  for(const content of [skill,register]){
    expect(content).toContain('query_receivables');expect(content).toContain('summarize_receivables');
    expect(content).not.toMatch(/open_ledger|close_ledger/);
  }
  expect(skill).toContain('用户选择');expect(skill).toContain('新任务或新部署必须重新查询');
});

it('uses a genuinely large synthetic business response but exact decimal expectations',()=>{
  const response=ledgerFixture('AR-200');expect(response.items).toHaveLength(200);
  expect(Buffer.byteLength(JSON.stringify(response))).toBeGreaterThan(256*1024);
  expect(ledgerFixture('AR-MISSING')).toBeUndefined();
  expect(ledgerFixture('constructor')).toBeUndefined();
  expect(ledgerFixture('AR-EMPTY').items).toEqual([]);
});
