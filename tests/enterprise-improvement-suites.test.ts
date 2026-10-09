import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {unzipSync} from 'fflate';
// @ts-expect-error Acceptance data stays outside the production bundle.
import {enterpriseHoldouts,enterpriseImprovementSuite} from '../acceptance/enterprise-migration-examples/improvement-suites.mjs';
import {simpleMigrationSuiteSchema} from '../src/migration/domain/simple-migration-suite.js';

it.each(Object.keys(enterpriseHoldouts))('freezes disjoint development and new behavioral holdouts for %s',id=>{
  const original=JSON.parse(readFileSync(`acceptance/enterprise-migration-examples/${id}/suite.json`,'utf8'));
  const suite=enterpriseImprovementSuite(id,original);
  expect(()=>simpleMigrationSuiteSchema.parse(suite)).not.toThrow();
  expect(suite.cases).toHaveLength(3);expect(suite.holdoutCases.length).toBeGreaterThanOrEqual(3);
  const ids=[...suite.cases,...suite.holdoutCases].map(c=>c.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(original.holdoutCases).toEqual([]);
  // Acceptance prompts/answers must not be bundled into the source Skill.
  const source=unzipSync(readFileSync(`acceptance/enterprise-migration-examples/${id}/source.zip`));
  for(const bytes of Object.values(source))for(const c of suite.holdoutCases)expect(Buffer.from(bytes).includes(Buffer.from(c.input))).toBe(false);
});
it('mounts expense acceptance inputs at the original business-relative workspace paths',()=>{
 const original=JSON.parse(readFileSync('acceptance/enterprise-migration-examples/01-expense/suite.json','utf8'));
 const suite=enterpriseImprovementSuite('01-expense',original);
 for(const example of [...suite.cases,...suite.holdoutCases])for(const file of example.workspaceFiles??[])
  if(file.path.endsWith('.json'))expect(file.path).toMatch(/^workspace\/EXP-\d+\.json$/);
 const source=unzipSync(readFileSync('acceptance/enterprise-migration-examples/01-expense/source.zip'));
 const implementation=Object.entries(source).find(([name])=>name.endsWith('scripts/check_expense.py'))![1];
 expect(Buffer.from(implementation).toString()).toContain("_check_expense(claim_id, 'workspace')");
});
