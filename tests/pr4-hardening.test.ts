import { afterEach, expect, it, vi } from 'vitest';
import {spawn} from 'node:child_process';
vi.mock('node:child_process',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:child_process')>();
  return {...actual,spawn:vi.fn(actual.spawn)};
});
import { LocalWorker } from '../src/service/local-worker.js';
import { validateMcpTool } from '../src/mcp-preflight.js';

afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
const job=(script:string)=>({requestId:'test',program:'node',args:['test.js'],files:[{path:'test.js',content:Buffer.from(script)}]});
it('disables local scripts by default',async()=>{
  vi.stubEnv('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS','');
  await expect(new LocalWorker().run(job(''))).rejects.toThrow('disabled');
});
it('does not forward service secrets to trusted scripts',async()=>{
  vi.stubEnv('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS','1');vi.stubEnv('REVIEW_SECRET','test');
  const result=await new LocalWorker().run(job('console.log(JSON.stringify({secret:process.env.REVIEW_SECRET??null}))'));
  expect(JSON.parse(result.stdout).secret).toBeNull();
});
it('terminates excessive output immediately',async()=>{
  vi.mocked(spawn).mockClear();
  vi.stubEnv('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS','1');
  const result=await new LocalWorker().run({...job('setInterval(()=>process.stdout.write("x".repeat(8192)),1)'),maxOutputBytes:1024,timeoutMs:3000});
  expect(result.outputTruncated).toBe(true);expect(result.timedOut).toBe(false);
  expect(vi.mocked(spawn).mock.calls.filter(call=>call[0]==='taskkill')).toHaveLength(process.platform==='win32'?1:0);
});
it.skipIf(process.platform==='win32')('reaps descendants holding pipes on timeout',async()=>{
  vi.stubEnv('FINANCE_EVAL_TRUSTED_LOCAL_SCRIPTS','1');
  const result=await new LocalWorker().run({...job('require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});setInterval(()=>{},1000)'),timeoutMs:150});
  expect(result.timedOut).toBe(true);
},3000);
it('rejects MCP tool error results despite successful JSON-RPC',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{
    const req=JSON.parse(init.body||'{}');
    if(req.method==='notifications/initialized')return new Response(null,{status:202});
    const result=req.method==='initialize'?{protocolVersion:'2025-06-18'}:req.method==='tools/list'?{tools:[{name:'test',inputSchema:{type:'object'}}]}:{isError:true,content:[{type:'text',text:'failed'}]};
    return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result}));
  }));
  const result=await validateMcpTool({endpoint:'http://localhost/mcp',toolName:'test'});
  expect(result.status).toBe('failed');expect(result.error).toContain('isError=true');
});
