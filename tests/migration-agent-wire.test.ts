import { mkdir,mkdtemp,readFile,rm,writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:http';
import { afterEach,expect,it,vi } from 'vitest';
import { analyzeWithAgent,implementWithAgent,runMigrationAgent } from '../src/migration/infrastructure/migration-agent.js';
import {MigrationImplementationService} from '../src/migration/application/migration-implementation-service.js';
import {MigrationActivityStore} from '../src/migration/infrastructure/migration-activity.js';

const dirs:string[]=[];
const saved=process.env.FINANCE_EVAL_MIGRATION_PYTHON;
it('forwards subprocess activity before its final result without corrupting Unicode',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'migration-live-wire-'));dirs.push(root);
  await mkdir(path.join(root,'integrations','openjiuwen'),{recursive:true});await writeFile(path.join(root,'.runtime.local.json'),'{}');
  const event=JSON.stringify({activity:{kind:'tool_start',label:'调用工具：读取文件'}})+'\n';
  await writeFile(path.join(root,'integrations/openjiuwen/analyze_agent.py'),`const b=Buffer.from(${JSON.stringify(event)});process.stdout.write(b.subarray(0,66));setTimeout(()=>process.stdout.write(b.subarray(66)),20);setTimeout(()=>process.stdout.write(JSON.stringify({result:{status:'PRODUCED',payload:{ok:true}}})+'\\n'),200);`);
  process.env.FINANCE_EVAL_MIGRATION_PYTHON=process.execPath;
  const store=new MigrationActivityStore(root);let seen=false;
  const off=store.subscribe('p',()=>{void store.get('p').then(state=>{if(state?.status==='RUNNING'&&state.events.some(e=>e.label==='调用工具：读取文件'))seen=true;});});
  const result=await store.run('p',()=>runMigrationAgent('A2',{assetDigest:'a'.repeat(64)},{projectRoot:root,modelId:'fixture'}));off();
  expect(seen).toBe(true);expect(result.status).toBe('PRODUCED');
});
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

it.each(['A2','A4'] as const)('repairs a %s result through a tool-free model call without running the agent twice',async stage=>{
  let calls=0;
  const response=stage==='A2'
    ?{status:'PRODUCED',skill:{status:'COMPLIANT'},tools:[],dependencyAnalysis:{dependencies:[],chains:[]}}
    :{status:'PRODUCED',tools:[],skillDelivery:{skillFile:'SKILL.md',files:[]}};
  const server=createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=String(chunk);
    const request=JSON.parse(body) as {messages:Array<{content:string}>;tools?:unknown};
    expect(request.tools).toBeUndefined();
    expect(request.messages.at(-1)?.content).toContain('validationErrors');
    calls++;
    res.writeHead(200,{'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(response)}}],model:'test'}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address();if(!address||typeof address==='string')throw Error('test server port unavailable');
  const role=stage==='A2'?'ANALYZER':'MIGRATION';
  const names=[`FINANCE_EVAL_${role}_BASE_URL`,`FINANCE_EVAL_${role}_API_KEY`,`FINANCE_EVAL_${role}_MODEL`,'FINANCE_EVAL_MIGRATION_AGENT'] as const;
  const before=names.map(name=>process.env[name]);
  const root=await mkdtemp(path.join(os.tmpdir(),'migration-wire-repair-'));dirs.push(root);
  try{
    process.env[names[0]]=`http://127.0.0.1:${address.port}`;
    process.env[names[1]]='test';process.env[names[2]]='test-model';
    process.env.FINANCE_EVAL_MIGRATION_AGENT='on';process.env.FINANCE_EVAL_MIGRATION_PYTHON=process.execPath;
    await mkdir(path.join(root,'integrations','openjiuwen'),{recursive:true});
    const entry=stage==='A2'?'analyze_agent.py':'migrate_agent.py';
    const countFile=path.join(root,'agent-count');
    await writeFile(path.join(root,'integrations','openjiuwen',entry),
      `require('node:fs').appendFileSync(${JSON.stringify(countFile)},'1');`
      +`process.stdout.write(JSON.stringify({result:{status:"FAILED",assetDigest:${JSON.stringify('a'.repeat(64))},`
      +`payload:{},rawOutput:'{"status":"PRODUCED","tools":',outputParseFailed:true,rawOutputTruncated:false,`
      +`scanner:{coverage:1},files:{'migration-skill/SKILL.md':'IyB0ZXN0'},error:'JSON_INVALID'}})+"\\n");`);
    await writeFile(path.join(root,'.runtime.local.json'),'{}');
    const options={projectRoot:root,modelId:'stub'},files={'SKILL.md':new TextEncoder().encode('# t')};
    const result=stage==='A2'
      ?await analyzeWithAgent({assetDigest:'a'.repeat(64),runId:'r',files},options)
      :await implementWithAgent({assetDigest:'a'.repeat(64),runId:'r',files,decisions:[],tools:[],contract:{}},options);
    expect(result?.status).toBe('PRODUCED');
    if(stage==='A2')expect(result&&'scanner' in result?result.scanner:undefined).toEqual({coverage:1});
    else expect(result&&'files' in result?result.files:undefined).toHaveProperty('migration-skill/SKILL.md');
    expect(await readFile(countFile,'utf8')).toBe('1');expect(calls).toBe(1);
  }finally{
    for(const [index,name] of names.entries())if(before[index]===undefined)delete process.env[name];else process.env[name]=before[index];
    await new Promise<void>(resolve=>server.close(()=>resolve()));
  }
});

it('does not repeat A4 code generation after an unrepaired output-format failure',async()=>{
  const previous=process.env.FINANCE_EVAL_AGENT_ATTEMPTS;process.env.FINANCE_EVAL_AGENT_ATTEMPTS='2';
  try{
    const implementer=vi.fn(async()=>({status:'FAILED' as const,reason:'JSON_INVALID',failureKind:'OUTPUT_FORMAT' as const}));
    const service=new MigrationImplementationService(implementer,{contractSample:()=>({reason:'none'})} as any);
    await expect(service.generate({},{tools:[{toolId:'t1',name:'lookup',language:'python',samples:[]}]} as any,
      [{toolId:'t1',form:'SCRIPT',language:'python'}] as any,
      {assetId:'asset',artifactSha256:'a'.repeat(64)} as any,{items:[{toolId:'t1',language:'python'}]} as any))
      .rejects.toThrow('不重复执行代码生成');
    expect(implementer).toHaveBeenCalledTimes(1);
  }finally{
    if(previous===undefined)delete process.env.FINANCE_EVAL_AGENT_ATTEMPTS;else process.env.FINANCE_EVAL_AGENT_ATTEMPTS=previous;
  }
});

it('records A4 agent attempts separately from format-only corrections',async()=>{
  const implementer=vi.fn(async()=>({status:'PRODUCED' as const,payload:{tools:[{toolId:'t1',compilePassed:true,contractPassed:true}]},
    files:{},outputCorrectionAttempts:1}));
  const mapper={contractSample:()=>({reason:'none'}),generatedImplementations:()=>({t1:{language:'python'}}),
    skillDocumentDelivery:()=>({files:{'SKILL.md':'---\nname: test\ndescription: test\n---\n'}})};
  const service=new MigrationImplementationService(implementer,mapper as unknown as ConstructorParameters<typeof MigrationImplementationService>[1]);
  const result=await service.generate({},{tools:[{toolId:'t1',name:'lookup',language:'python',samples:[]}]} as any,
    [{toolId:'t1',form:'SCRIPT',language:'python'}] as any,
    {assetId:'asset',artifactSha256:'a'.repeat(64)} as any,{items:[{toolId:'t1',language:'python'}]} as any);
  expect(result.generationStats).toEqual({agentAttempts:1,outputCorrectionAttempts:1});
  expect(implementer).toHaveBeenCalledTimes(1);
});

it('keeps a Skill with no business tools without invoking the generation agent',async()=>{
  const implementer=vi.fn();
  const service=new MigrationImplementationService(implementer,{} as ConstructorParameters<typeof MigrationImplementationService>[1]);
  const result=await service.generate({},{tools:[],runtimeCapabilities:[{name:'host_capability'}]} as any,[],
    {assetId:'asset',artifactSha256:'a'.repeat(64)} as any,{items:[]} as any);
  expect(result).toMatchObject({implementations:{},generationStats:{agentAttempts:0,outputCorrectionAttempts:0}});
  expect(implementer).not.toHaveBeenCalled();
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
