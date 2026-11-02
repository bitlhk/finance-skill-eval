import { afterEach, expect, it, vi } from 'vitest';
import {spawn} from 'node:child_process';
vi.mock('node:child_process',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:child_process')>();
  return {...actual,spawn:vi.fn(actual.spawn)};
});
import { validateMcpTool } from '../src/mcp-preflight.js';

afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
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
