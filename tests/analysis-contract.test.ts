import { expect, it } from 'vitest';
import { contractSample, toProjectInspection } from '../src/service/migration-agent.js';
import { stableToolId } from '../src/migration/domain/migration-model.js';

const FILES = {
  'skill/SKILL.md': '---\nname: balance\ndescription: 查询余额。\n---\n调用 `lookup`，传入 account_id。\n成功时返回币种与账面余额。\n',
  'tool/lookup.py': 'def lookup(account_id):\n    return {"currency": "CNY", "ledger_balance": "1.00"}\n',
};
const inspect = (tool: Record<string, unknown>) =>
  toProjectInspection({ skill: { status: 'COMPLIANT', findings: [] }, tools: [{ name: 'lookup', ...tool }] } as never,
    'asset', 'a'.repeat(64), stableToolId, null, FILES).tools[0]!;

it('locates a contract where the text it quotes actually is', () => {
  const tool = inspect({ input: { description: '传入 account_id', path: 'skill/SKILL.md', snippet: '调用 `lookup`，传入 account_id' } });
  expect(tool.evidence).toContainEqual({ path: 'skill/SKILL.md', line: 5, kind: 'INPUT_CONTRACT', detail: '传入 account_id' });
});

it('takes no location at all from a line number the analysis supplied', () => {
  // Measured twice: with correct numbers in front of it, the agent put all eight of its claims on a
  // line that does not contain the text it quoted. A number is not evidence, so it is not a
  // fallback either -- the claim simply has no location, and therefore is not a contract.
  const tool = inspect({ input: { description: '传入 account_id', schema: { type: 'object' }, path: 'skill/SKILL.md', line: 5 } });
  expect(tool.inputSchema).toBeNull();
  expect(tool.evidence.some(item => item.kind === 'INPUT_CONTRACT')).toBe(false);
});

it('refuses a quote too short to identify a line', () => {
  const tool = inspect({ input: { description: '传入 account_id', path: 'skill/SKILL.md', snippet: '调' } });
  expect(tool.evidence.some(item => item.kind === 'INPUT_CONTRACT')).toBe(false);
});

it('reports an unlocatable contract as unread rather than keeping the guess', () => {
  // The whole point of the citation: a contract the analysis cannot point at is not usable as a
  // baseline, and downstream compares the migration against it.
  const tool = inspect({ input: { description: '大概是这个', schema: { type: 'object' }, path: 'skill/SKILL.md', snippet: '这句话文件里没有' } });
  expect(tool.inputSchema).toBeNull();
  expect(tool.evidence.some(item => item.kind === 'INPUT_CONTRACT')).toBe(false);
});

it('keeps the schema only when its quote can be found', () => {
  const schema = { type: 'object', properties: { account_id: { type: 'string' } }, required: ['account_id'] };
  const cited = inspect({ input: { schema, path: 'tool/lookup.py', snippet: 'def lookup(account_id):' } });
  expect(cited.inputSchema).toEqual(schema);
  const uncited = inspect({ output: { schema, path: 'tool/lookup.py', snippet: 'def something_else(' } });
  expect(uncited.outputSchema).toBeNull();
});

it('takes samples from the analysis and drops the ones it cannot locate', () => {
  const tool = inspect({
    samples: [
      { input: { account_id: 'A10001' }, output: { currency: 'CNY' }, path: 'skill/SKILL.md', snippet: '调用 `lookup`，传入 account_id' },
      { input: { account_id: 'NOPE' }, path: 'skill/SKILL.md', snippet: '这一行不在文件里' },
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

it('reads a path the agent named from its own workspace', () => {
  // The agent reads the package inside the workspace it was handed, so it names files the way it
  // reached them. One field run said `C:\...\Temp\finance-migration-ws-XXXX\skill\SKILL.md` for
  // every claim it made, none of them matched a key in `files`, and the entire baseline -- the
  // thing A4 is compared against -- was dropped without a word.
  const tool = inspect({ input: { description: '传入 account_id',
    path: 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\finance-migration-ws-z2s82zu5\\skill\\SKILL.md',
    snippet: '调用 `lookup`，传入 account_id' } });
  expect(tool.evidence).toContainEqual({ path: 'skill/SKILL.md', line: 5, kind: 'INPUT_CONTRACT', detail: '传入 account_id' });
});

it('keeps a temp path out of what the platform records', () => {
  const tool = inspect({ sourcePaths: ['C:\\Users\\Administrator\\AppData\\Local\\Temp\\ws-1\\tool\\lookup.py'],
    entrypoint: { kind: 'PYTHON', path: 'C:\\Users\\Administrator\\AppData\\Local\\Temp\\ws-1\\tool\\lookup.py' } });
  expect(tool.sourcePaths).toEqual(['tool/lookup.py']);
  expect(tool.entrypoint).toEqual({ kind: 'PYTHON', path: 'tool/lookup.py' });
});

it('does not pick a file when the tail names two of them', () => {
  // Two files with the same tail is a question the path cannot answer, and a baseline that points
  // at the wrong one is worse than a missing entry.
  const ambiguous = { ...FILES, 'other/SKILL.md': '另一份 SKILL.md。\n' };
  const tool = toProjectInspection({ skill: { status: 'COMPLIANT', findings: [] },
    tools: [{ name: 'lookup', input: { description: 'x', path: 'C:/ws/SKILL.md', snippet: '另一份 SKILL.md' } }] } as never,
    'asset', 'a'.repeat(64), stableToolId, null, ambiguous).tools[0]!;
  expect(tool.evidence.some(item => item.kind === 'INPUT_CONTRACT')).toBe(false);
});

it('refuses to synthesize a test input when the analysis found no sample', () => {
  // Deriving a sample from the Schema would be a guess built on a guess: the Schema is itself an
  // analysis reading. Better to say the call cannot be exercised.
  expect(contractSample({ samples: [{ input: { account_id: 'A10001' } }] })).toEqual({ input: { account_id: 'A10001' } });
  expect(contractSample({ samples: [] })).toEqual({ reason: '分析没有读出样例，无法构造调用输入' });
  expect(contractSample(undefined)).toEqual({ reason: '分析没有读出样例，无法构造调用输入' });
});

it('refuses a block quote with invented blank lines', () => {
  // Normalize line endings, but preserve the source text. Inserted blank lines are not a source quote.
  const block = { 'tool/pay.py': 'def pay(subtotal):\n    return ToolResponse(content={\n        "status": "ok",\n        "total": "1.00",\n    })\n' };
  const tool = toProjectInspection({ skill: { status: 'COMPLIANT', findings: [] }, tools: [{ name: 'pay',
    output: { description: 'ok plus total', path: 'tool/pay.py',
      snippet: 'return ToolResponse(content={\n\n        "status": "ok",\n\n        "total": "1.00",' } }] } as never,
    'asset', 'a'.repeat(64), stableToolId, null, block).tools[0]!;
  expect(tool.evidence.some(item => item.kind === 'OUTPUT_CONTRACT')).toBe(false);
});

it('still refuses a quote whose tokens do not match', () => {
  // Whitespace is the only thing taken loosely. A token added, dropped or reordered is not a quote.
  const tool = inspect({ input: { description: 'x', path: 'skill/SKILL.md',
    snippet: '调用 lookup，传入 account_id 和 tenant_id' } });
  expect(tool.evidence.some(item => item.kind === 'INPUT_CONTRACT')).toBe(false);
});

it('counts a file the scanner read as coverage, not as a gap', () => {
  // The scanner says `TEXT_INSPECTED` for a file it read as text and `AST_PARSED` for Python it
  // parsed -- both mean it saw the file. The gap check was written against `PARSED|OK`, which the
  // scanner never emits, so every package came back partially analysed: A4's generation was
  // refused, and the page asked a human to confirm a shortfall that did not exist. Nothing behind
  // the dialog, on every run.
  const analysis = toProjectInspection({ skill: { status: 'COMPLIANT', findings: [] }, tools: [] } as never,
    'asset', 'a'.repeat(64), stableToolId,
    { coverage: [{ path: 'skill/SKILL.md', status: 'TEXT_INSPECTED' },
      { path: 'skill/tool.py', status: 'AST_PARSED' },
      { path: 'skill/broken.py', status: 'PARSE_FAILED' },
      { path: 'skill/big.bin', status: 'SIZE_LIMIT' }] }, FILES);
  expect(analysis.staticAnalysis?.incompleteFiles).toEqual([
    { path: 'skill/broken.py', status: 'PARSE_FAILED' },
    { path: 'skill/big.bin', status: 'SIZE_LIMIT' },
  ]);
  expect(analysis.staticAnalysis?.status).toBe('PARTIAL');
});

it('treats a coverage status it does not know as a gap', () => {
  // Fail-safe: the gate exists to make a human look, so a new status from the scanner must not
  // open it by accident.
  const analysis = toProjectInspection({ skill: { status: 'COMPLIANT', findings: [] }, tools: [] } as never,
    'asset', 'a'.repeat(64), stableToolId,
    { coverage: [{ path: 'skill/tool.py', status: 'SOMETHING_NEW' }] }, FILES);
  expect(analysis.staticAnalysis?.incompleteFiles).toEqual([{ path: 'skill/tool.py', status: 'SOMETHING_NEW' }]);
});
