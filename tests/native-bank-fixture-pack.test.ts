import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { loadEvalPack } from '../src/eval-pack.js';

describe('versioned native bank fixture', () => {
  it('keeps Skill identity while replacing the unrelated legacy case', async () => {
    const pack = await loadEvalPack('packs/finance/native-readonly-balance/eval.yaml');
    expect(pack.version).toBe('1.0.4');
    expect(pack.targetSkillVersion).toBe('1.0.3');
    expect(pack.cases.map(c => c.caseId)).toEqual(['NATIVE-ACCOUNTS-20261002']);
    const c = pack.cases[0]!;
    expect(c.evaluationGoal).not.toContain('12345.67');
    expect(c.evaluationGoal).toContain('acct-usd-001');
    expect(c.evaluationGoal).toContain('128650.32');
    expect(c.requiredTools).toEqual(['account_balance_query', 'read_case_file']);
    expect(c.workspaceFiles).toEqual([{path: 'case.txt', content: 'NATIVE_ACCOUNTS_20261002'}]);
    expect(c.workspaceFiles?.[0]?.content).not.toContain('128650');
    const old = await readFile('packs/finance/native-readonly-balance/cases/balance.yaml', 'utf8');
    expect(old).toContain('NATIVE-BALANCE-001');
    expect(old).toContain('12345.67');
  });
});
