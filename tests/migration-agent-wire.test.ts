import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { analyzeWithAgent,implementWithAgent,runMigrationAgent } from '../src/migration/infrastructure/migration-agent.js';

const dirs:string[]=[];
const saved=process.env.FINANCE_EVAL_MIGRATION_PYTHON;
afterEach(async()=>{
  for(const dir of dirs.splice(0))await rm(dir,{recursive:true,force:true});
  if(saved===undefined)delete process.env.FINANCE_EVAL_MIGRATION_PYTHON;else process.env.FINANCE_EVAL_MIGRATION_PYTHON=saved;
});

/**
 * A fake agent on the real spawn path.
 *
 * The interpreter is this same node, and the entry file -- whose name and location the platform
 * fixes -- holds JavaScript that prints whatever the case needs. Nothing here is mocked: the
 * reason a real agent's failure reaches a reader travels through this exact code.
 */
async function runStub(stage:'A2'|'A4',result:Record<string,unknown>){
  const root=await mkdtemp(path.join(os.tmpdir(),'migration-wire-'));dirs.push(root);
  await mkdir(path.join(root,'integrations','openjiuwen'),{recursive:true});
  const entry=stage==='A2'?'analyze_agent.py':'migrate_agent.py';
  await writeFile(path.join(root,'integrations','openjiuwen',entry),
    `process.stdout.write(JSON.stringify({result:${JSON.stringify(result)}})+"\\n");`);
  await writeFile(path.join(root,'.runtime.local.json'),'{}');
  process.env.FINANCE_EVAL_MIGRATION_PYTHON=process.execPath;
  return await runMigrationAgent(stage,{assetDigest:'a'.repeat(64)},{projectRoot:root,modelId:'stub'});
}

it('reports the reason an agent leaves in its output, not only the one it puts on the wire',async()=>{
  // What a parse failure looks like: the agent knows why it failed -- the answer was not the JSON
  // it was told to give -- and the evidence is the text itself, so there is nothing on `error`.
  const result=await runStub('A2',{status:'FAILED',payload:{},rawOutput:'我先说明思路。\n结论：这个包是合规的。'});
  expect(result.status).toBe('FAILED');
  expect(result.run.error).toContain('结论：这个包是合规的');
  expect(result.run.error).toContain('原始输出末尾');
});

it('takes the agent\'s own reason when it gives one',async()=>{
  const result=await runStub('A2',{status:'FAILED',payload:{},error:'结果不是约定的 JSON：Expecting value','rawOutput':'ignored'});
  expect(result.run.error).toBe('结果不是约定的 JSON：Expecting value');
});

it('does not invent a failure to explain for a run that produced its payload',async()=>{
  // Quoting a successful run's output back as an error would be worse than saying nothing.
  const result=await runStub('A2',{status:'PRODUCED',payload:{status:'PRODUCED'},rawOutput:'{"status":"PRODUCED"}'});
  expect(result.status).toBe('PRODUCED');
  expect(result.run.error).toBeUndefined();
});

it('passes that reason all the way out to the store, for both stages',async()=>{
  const files={'SKILL.md':new TextEncoder().encode('# t')};
  // Through the hand-offs the store actually calls: drop the reason at either seam and the reader
  // is back to being told, uselessly, that no reason was given.
  process.env.FINANCE_EVAL_MIGRATION_AGENT='on';
  try{
    for(const [stage,call] of [
      ['A2',async(root:string)=>{process.env.FINANCE_EVAL_MIGRATION_PYTHON=process.execPath;
        return await analyzeWithAgent({assetDigest:'a'.repeat(64),runId:'r',files},{projectRoot:root,modelId:'stub'});}],
      ['A4',async(root:string)=>{process.env.FINANCE_EVAL_MIGRATION_PYTHON=process.execPath;
        return await implementWithAgent({assetDigest:'a'.repeat(64),runId:'r',files,decisions:[],tools:[],contract:{}},{projectRoot:root,modelId:'stub'});}],
    ] as const){
      const root=await mkdtemp(path.join(os.tmpdir(),'migration-wire-store-'));dirs.push(root);
      await mkdir(path.join(root,'integrations','openjiuwen'),{recursive:true});
      const entry=stage==='A2'?'analyze_agent.py':'migrate_agent.py';
      await writeFile(path.join(root,'integrations','openjiuwen',entry),
        'process.stdout.write(JSON.stringify({result:{status:"FAILED",payload:{},rawOutput:"模型答成了散文"}})+"\\n");');
      await writeFile(path.join(root,'.runtime.local.json'),'{}');
      const handoff=await call(root);
      expect(handoff?.status).toBe('FAILED');
      expect(handoff&&'reason' in handoff?handoff.reason:'').toContain('模型答成了散文');
    }
  }finally{delete process.env.FINANCE_EVAL_MIGRATION_AGENT;}
});

it('sends the model call its output budget, and lets an operator raise it per stage',async()=>{
  // The agents read `maxTokens` from the request, but the platform never sent the field -- so the
  // budget was a literal in the Python source and the only way to change it was to edit that file,
  // which is not something an operator who sees the failure can do. It has to travel like the
  // iteration budget does.
  const seen:number[]=[],bodies:string[]=[];
  const root=await mkdtemp(path.join(os.tmpdir(),'migration-wire-budget-'));dirs.push(root);
  await mkdir(path.join(root,'integrations','openjiuwen'),{recursive:true});
  // The stub hands the request straight back as its raw output, so the assertion is on what the
  // platform actually wrote to the agent. `String.fromCharCode(10)` rather than an escape: this
  // source is itself built inside a template literal, and a doubly-escaped newline is how this
  // test silently became a stub with a syntax error.
  await writeFile(path.join(root,'integrations','openjiuwen','analyze_agent.py'),
    `let raw="";process.stdin.on("data",c=>raw+=c).on("end",()=>{`
    + `process.stdout.write(JSON.stringify({result:{status:"FAILED",payload:{},rawOutput:raw}})`
    + `+String.fromCharCode(10));});`);
  await writeFile(path.join(root,'.runtime.local.json'),'{}');
  process.env.FINANCE_EVAL_MIGRATION_PYTHON=process.execPath;
  // The stub's echo comes back through `error`, which is where the platform puts an agent's own
  // last words when it fails to explain itself.
  const sent=async()=>{
    const result=await runMigrationAgent('A2',{assetDigest:'a'.repeat(64)},{projectRoot:root,modelId:'stub'});
    return String(result.run.error??'');
  };
  const budgetOf=(text:string)=>{
    const found=/"maxTokens":(\d+)/u.exec(text);
    if(!found)throw new Error(`the body did not reach the agent: ${text}`);
    return Number(found[1]);
  };
  const run=async()=>{const text=await sent();bodies.push(text);return text;};
  try{
    seen.push(budgetOf(await run()));
    // One value for both stages...
    process.env.FINANCE_EVAL_AGENT_MAX_TOKENS='9000';
    seen.push(budgetOf(await run()));
    // ...overridden by this stage's own role, which outranks it.
    process.env.FINANCE_EVAL_ANALYZER_MAX_TOKENS='15000';
    seen.push(budgetOf(await run()));
  }finally{
    delete process.env.FINANCE_EVAL_AGENT_MAX_TOKENS;
    delete process.env.FINANCE_EVAL_ANALYZER_MAX_TOKENS;
  }
  // A reasoning model spends the same budget on thinking and on answering, so the default has to
  // clear the reasoning too -- a cap sized for the answer alone comes back empty, with no error.
  expect(seen[0]).toBeGreaterThanOrEqual(32_000);
  expect(seen[1]).toBe(9000);
  expect(seen[2]).toBe(15000);
  // The per-call deadline rides along. The harness's own is 60 s, which a reasoning model passes
  // routinely, and it says so by failing the whole run with "model call failed ... Request timed
  // out" -- a sentence that reads as a fact about the package.
  expect(bodies[2]).toMatch(/"modelTimeoutMs":\d+/u);
  expect(Number(/"modelTimeoutMs":(\d+)/u.exec(bodies[2])![1])).toBeGreaterThan(60_000);
});
