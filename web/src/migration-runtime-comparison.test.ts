import {describe,expect,it} from 'vitest';
import {allRuntimeSidesPass,commonRuntimeModels,DEFAULT_RUNTIME_GENERATION,migrationRuntimeLabel,runtimeModelReference} from './migration-runtime-comparison';
import type {MigrationRuntime} from './types';

function runtime(runtimeId:string,runtimeType:MigrationRuntime['runtimeType'],modelId:string,upstreamModelId:string):MigrationRuntime{
  return {runtimeId,launcherEnvironmentId:runtimeId,name:runtimeId,runtimeType,endpoint:'http://127.0.0.1/',defaultModelId:modelId,mcpEnvironmentIds:[],toolCount:0,transport:'runtime_launcher',models:[{providerId:`runtime-launcher:${runtimeId}`,modelId,upstreamModelId,parameters:{}}]};
}

describe('migration Runtime comparison UI contract',()=>{
  it('pairs different side model IDs only when their actual upstream model matches',()=>{
    const left=runtime('oj','openjiuwen','oj-model','shared-upstream');
    const right=runtime('as','agentscope','as-model','shared-upstream');
    const common=commonRuntimeModels(left,right);
    expect(common).toHaveLength(1);
    expect(common[0]).toMatchObject({upstreamModelId:'shared-upstream',left:{modelId:'oj-model'},right:{modelId:'as-model'}});
    expect(commonRuntimeModels(left,runtime('other','agentscope','oj-model','different-upstream'))).toEqual([]);
  });

  it('keeps legacy generic HTTP identity explicit and sends only supported generation fields',()=>{
    expect(migrationRuntimeLabel('generic_http')).toBe('通用 HTTP Runtime（执行时核验身份）');
    expect(migrationRuntimeLabel('agentscope')).toBe('AgentScope Java');
    expect(runtimeModelReference(runtime('oj','openjiuwen','model','upstream').models[0]!,DEFAULT_RUNTIME_GENERATION).parameters)
      .toEqual({temperature:0,top_p:1,max_tokens:2048});
    const generation={...DEFAULT_RUNTIME_GENERATION,thinking:{type:'disabled' as const}};
    expect(runtimeModelReference(runtime('oj','openjiuwen','model','upstream').models[0]!,generation).parameters)
      .toEqual(generation);
  });

  it('marks CC quality successful only when every side is assessed PASS',()=>{
    const pass={status:'assessed' as const,assessment:{verdict:'PASS' as const}};
    expect(allRuntimeSidesPass([{judge:{runtimeComparison:{left:pass,right:pass}}}])).toBe(true);
    expect(allRuntimeSidesPass([{judge:{runtimeComparison:{left:pass,right:{status:'unavailable',error:'controlled'}}}}])).toBe(false);
    expect(allRuntimeSidesPass([{judge:{runtimeComparison:{left:pass,right:{status:'assessed',assessment:{verdict:'INDETERMINATE'}}}}}])).toBe(false);
  });
});
