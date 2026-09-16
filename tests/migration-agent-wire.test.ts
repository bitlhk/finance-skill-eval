import { mkdir,mkdtemp,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach,expect,it } from 'vitest';
import { analyzeWithAgent,implementWithAgent,runMigrationAgent } from '../src/service/migration-agent.js';

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
