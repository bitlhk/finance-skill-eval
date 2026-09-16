import { expect, it } from 'vitest';
import { contractSample, toProjectInspection } from '../src/service/migration-agent.js';
import { stableToolId } from '../src/service/migration-model.js';

const FILES = {
  'skill/SKILL.md': '---\nname: balance\ndescription: 查询余额。\n---\n调用 `lookup`，传入 account_id。\n成功时返回币种与账面余额。\n',
  'tool/lookup.py': 'def lookup(account_id):\n    return {"currency": "CNY", "ledger_balance": "1.00"}\n',
};
const inspect = (tool: Record<string, unknown>) =>
  toProjectInspection({ skill: { status: 'COMPLIANT', findings: [] }, tools: [{ name: 'lookup', ...tool }] } as never,
    'asset', 'a'.repeat(64), stableToolId, null, FILES).tools[0]!;

it('accepts an input contract only where the analysis can point at it', () => {
  const tool = inspect({ input: { description: '传入 account_id', path: 'skill/SKILL.md', line: 5 } });
  expect(tool.evidence).toContainEqual({ path: 'skill/SKILL.md', line: 5, kind: 'INPUT_CONTRACT', detail: '传入 account_id' });
});

it('reports an unlocatable contract as unread rather than keeping the guess', () => {
  // The whole point of the citation: a contract the analysis cannot point at is not usable as a
  // baseline, and downstream compares the migration against it.
  const tool = inspect({ input: { description: '大概是这个', schema: { type: 'object' }, path: 'skill/SKILL.md', line: 99 } });
  expect(tool.inputSchema).toBeNull();
  expect(tool.evidence.some(item => item.kind === 'INPUT_CONTRACT')).toBe(false);
});

it('keeps the schema only when its line is real', () => {
  const schema = { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] };
  const cited = inspect({ input: { schema, path: 'tool/lookup.py', line: 1 } });
  expect(cited.inputSchema).toEqual(schema);
  const uncited = inspect({ output: { schema, path: 'tool/lookup.py', line: 40 } });
  expect(uncited.outputSchema).toBeNull();
});

it('takes samples from the analysis and drops the ones it cannot locate', () => {
  const tool = inspect({
    samples: [
      { input: { account_id: 'A10001' }, output: { currency: 'CNY' }, path: 'skill/SKILL.md', line: 5 },
      { input: { account_id: 'NOPE' }, path: 'skill/SKILL.md', line: 42 },
    ],
  });
  expect(tool.samples).toEqual([{ input: { account_id: 'A10001' }, output: { currency: 'CNY' }, path: 'skill/SKILL.md', line: 5 }]);
});

it('finds a contract by the text it quotes, not by the line number it counted', () => {
  // Counting lines is arithmetic an agent is bad at: a real run cited line 25 of a 19-line file for
  // every contract it read, and the whole baseline was dropped while the text it quoted sat right
  // there. The quote is the evidence; the number is a hint.
  const tool = inspect({ input: { description: '传入 account_id', snippet: '调用 `lookup`，传入 account_id',
    path: 'skill/SKILL.md', line: 25 } });
  expect(tool.inputSchema).toBeNull();
  expect(tool.evidence).toContainEqual({ path: 'skill/SKILL.md', line: 5, kind: 'INPUT_CONTRACT', detail: '传入 account_id' });
});

it('drops a contract whose quoted text is nowhere in the file', () => {
  // A quote that cannot be found means the analysis did not read what it says it read, whatever
  // line it names.
  const tool = inspect({ input: { description: '编的', snippet: '这句话文件里没有', path: 'skill/SKILL.md', line: 5 } });
  expect(tool.evidence.some(item => item.kind === 'INPUT_CONTRACT')).toBe(false);
  expect(tool.inputSchema).toBeNull();
});

it('keeps an entrypoint that names a real file even when the line is wrong', () => {
  // Which file to run is the one thing the platform cannot work out for itself.
  const tool = inspect({ entrypoint: { kind: 'PYTHON', path: 'tool/lookup.py', line: 77 } });
  expect(tool.entrypoint).toEqual({ kind: 'PYTHON', path: 'tool/lookup.py' });
  expect(inspect({ entrypoint: { kind: 'PYTHON', path: 'tool/nope.py', line: 1 } }).entrypoint).toBeUndefined();
});

it('refuses to synthesize a test input when the analysis found no sample', () => {
  // Deriving a sample from the Schema would be a guess built on a guess: the Schema is itself an
  // analysis reading. Better to say the call cannot be exercised.
  expect(contractSample({ samples: [{ input: { account_id: 'A10001' } }] })).toEqual({ input: { account_id: 'A10001' } });
  expect(contractSample({ samples: [] })).toEqual({ reason: '分析没有读出样例，无法构造调用输入' });
  expect(contractSample(undefined)).toEqual({ reason: '分析没有读出样例，无法构造调用输入' });
});
