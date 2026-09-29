import {describe,it,expect,vi} from 'vitest';
import {EvaluationRunManager} from '../src/service/run-manager.js';

describe('Launcher native tool dependency resolution',()=>{
  const environment={type:'runtime_launcher',environmentId:'launcher',baseUrl:'http://127.0.0.1:9000/'};
  const create=(result:unknown)=>{
    const preflight=vi.fn(async()=>result);
    const manager=new EvaluationRunManager({environments:{preflight}} as never);
    const descriptor=(names:string[]) => (manager as any).environmentDescriptor(environment,names);
    return {descriptor,preflight};
  };
  it('accepts only advertised native tools and preserves requested names for launch-time validation',async()=>{
    const {descriptor}=create({status:'ready',capabilities:{nativeToolNames:['query_a']}});
    const result=await descriptor(['query_a']);
    expect(result.requiredToolNames).toEqual(['query_a']);
    expect(result.mcpServers).toEqual([]);
    expect(result.harnessToolNames).toEqual([]);
    await expect(descriptor(['query_b'])).rejects.toThrow('Required MCP tools are unavailable');
  });
  it('does not infer tools from a ready launcher without an inventory',async()=>{
    await expect(create({status:'ready',capabilities:{}}).descriptor(['query_a'])).rejects.toThrow('unavailable');
  });
  it('rejects failed preflight even when an inventory is present',async()=>{
    await expect(create({status:'failed',error:'unreachable',capabilities:{nativeToolNames:['query_a']}})
      .descriptor(['query_a'])).rejects.toThrow('preflight failed');
  });
});
