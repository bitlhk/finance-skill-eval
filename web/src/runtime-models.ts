import type {MigrationRuntime,ModelRef} from './types';

export type CommonRuntimeModel={upstreamModelId:string;label:string;left:ModelRef;right:ModelRef};

/** Compare real model identities, not Launcher-local aliases or provider labels. */
export function commonRuntimeModels(left:MigrationRuntime|undefined,right:MigrationRuntime|undefined):CommonRuntimeModel[]{
  if(!left||!right)return [];
  return left.models.flatMap(leftModel=>{
    if(!leftModel.upstreamModelId)return [];
    const rightModel=right.models.find(model=>model.upstreamModelId===leftModel.upstreamModelId);
    return rightModel?[{upstreamModelId:leftModel.upstreamModelId,label:leftModel.label??rightModel.label??leftModel.upstreamModelId,left:leftModel,right:rightModel}]:[];
  });
}
