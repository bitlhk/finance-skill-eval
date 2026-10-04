import type {MigrationRuntime,ModelRef} from './types';

export type RuntimeGeneration={temperature:number;top_p:number;max_tokens:number;thinking?:{type:'disabled'}};
export const DEFAULT_RUNTIME_GENERATION:RuntimeGeneration={temperature:0,top_p:1,max_tokens:2048};

export function migrationRuntimeLabel(type:MigrationRuntime['runtimeType']):string{
  if(type==='openjiuwen')return 'OpenJiuwen Java';
  if(type==='agentscope')return 'AgentScope Java';
  if(type==='ea')return 'EA Runtime';
  return '通用 HTTP Runtime（执行时核验身份）';
}

export function isRuntimeComparisonOption(runtime:MigrationRuntime):boolean{
  return runtime.runtimeType==='openjiuwen'||runtime.runtimeType==='agentscope'||runtime.runtimeType==='generic_http';
}

export type CommonRuntimeModel={upstreamModelId:string;label:string;left:ModelRef;right:ModelRef};

export function commonRuntimeModels(left:MigrationRuntime|undefined,right:MigrationRuntime|undefined):CommonRuntimeModel[]{
  if(!left||!right)return [];
  const values:CommonRuntimeModel[]=[];
  for(const leftModel of left.models){
    if(!leftModel.upstreamModelId)continue;
    const rightModel=right.models.find(candidate=>candidate.upstreamModelId===leftModel.upstreamModelId);
    if(!rightModel)continue;
    values.push({upstreamModelId:leftModel.upstreamModelId,label:leftModel.label??rightModel.label??leftModel.upstreamModelId,left:leftModel,right:rightModel});
  }
  return values;
}

export function runtimeModelReference(model:ModelRef,generation:RuntimeGeneration):ModelRef{
  return {providerId:model.providerId,modelId:model.modelId,label:model.label,parameters:{temperature:generation.temperature,top_p:generation.top_p,max_tokens:generation.max_tokens,...(generation.thinking?{thinking:{type:'disabled' as const}}:{})}};
}

type RuntimeSideResult={status:'assessed';assessment:{verdict:'PASS'|'FAIL'|'INDETERMINATE'}}|{status:'unavailable';error:string};
export function allRuntimeSidesPass(cases:Array<{judge?:{runtimeComparison?:{left:RuntimeSideResult;right:RuntimeSideResult}}|null}>):boolean{
  return cases.length>0&&cases.every(item=>{
    const result=item.judge?.runtimeComparison;
    return !!result&&(['left','right'] as const).every(side=>result[side].status==='assessed'&&result[side].assessment.verdict==='PASS');
  });
}
