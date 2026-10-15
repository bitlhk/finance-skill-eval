import {describe,it,expect,vi} from 'vitest';
import {EvaluationRunManager} from '../src/service/run-manager.js';

describe('Launcher native tool dependency resolution',()=>{
  it.each(['different-upstream','missing-alias'])('rejects incomparable actual execution models before creating either side: %s',async mutation=>{
    const inspect=vi.fn(async(record:{environmentId:string})=>({status:'ready',capabilities:{models:[{
      modelId:mutation==='missing-alias'&&record.environmentId==='right'?'other':'alias',
      upstreamModelId:record.environmentId==='right'&&mutation==='different-upstream'?'different':'actual-model',
    }]}}));
    const manager=new EvaluationRunManager({resolveMigrationRuntime:async environmentId=>({environmentId,type:'runtime_launcher'}),environments:{inspect}} as never);
    const internal=manager as any;
    internal.skillResolver=vi.fn();
    await expect(internal.runtimeFor({evaluationMode:'candidate_runtime_comparison',runtimeBindings:{left:{environmentId:'left'},right:{environmentId:'right'}}},
      {cases:[],models:{execution:{left:{modelId:'alias'},right:{modelId:'alias'}}}})).rejects.toThrow(/模型/);
    expect(inspect).toHaveBeenCalledTimes(2);expect(internal.skillResolver).not.toHaveBeenCalled();
  });
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
  it('passes full explicit method dependencies to both runtimes while retaining per-case requirements',async()=>{
    const manager=new EvaluationRunManager({resolveMigrationRuntime:async()=>environment,
      environments:{resolveLauncher:async()=>({launcher:{baseUrl:environment.baseUrl}}),headers:()=>({})}} as never);
    const internal=manager as any;
    internal.skillResolver=vi.fn(async()=>async()=>({skillId:'method',version:'1',artifactSha256:'a'.repeat(64),
      instructions:'---\nallowed-tools: [query_a, query_b]\n---\nUse appropriate tools.'}));
    internal.environmentDescriptor=vi.fn(async(_environment,names)=>({environmentId:'launcher',requiredToolNames:names}));
    const cases=[{requiredTools:['query_a']}];
    await internal.runtimeFor({runtimeBindings:{left:{environmentId:'oj',skillAssetId:'asset'},right:{environmentId:'as',skillAssetId:'asset'}}},
      {cases,metadata:{},models:{execution:{left:{modelId:'m'},right:{modelId:'m'}}},
        variants:{left:{mode:'skill_version'},right:{mode:'skill_version'}}});
    expect(internal.environmentDescriptor.mock.calls.map((c:any[])=>c[1])).toEqual([['query_a','query_b'],['query_a','query_b']]);
    expect(cases).toEqual([{requiredTools:['query_a']}]);
  });
});
