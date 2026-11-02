import type {ModelAdapter} from '../adapters.js';
import type {ModelRef} from '../contracts.js';
import type {RoleCallOptions} from './ports.js';
import {compositionReceipt, type loadAgentRole} from './composition.js';

/** Shared model-only role assembly. Callers own schemas and evidence-preserving repairs;
 * boundedAgentCall owns the deadline for the whole operation, including those repairs. */
export async function prepareModelRole(composition:ReturnType<typeof loadAgentRole>, input:unknown,
  options:RoleCallOptions, dependencies:{adapter:ModelAdapter;model:ModelRef}, signal:AbortSignal,
  additionalPrompt:string[]=[]){
  signal.throwIfAborted();
  if(composition.definition.executor!=='tool-free-model'||composition.definition.tools.length
    ||composition.definition.conditionalTools.length)throw new Error('Model-only role cannot register tools');
  const receipt=compositionReceipt(composition,input,dependencies.model,
    {kind:'singleCompletion',timeoutMs:options.timeoutMs??120_000});
  await options.onComposition?.(receipt);
  signal.throwIfAborted();
  const systemPrompt=[composition.systemPrompt,...additionalPrompt].join('\n\n');
  return {receipt,complete:async(payload:unknown)=>{
    signal.throwIfAborted();
    const response=await dependencies.adapter.complete({requestId:options.requestId,model:dependencies.model,
      responseFormat:'json',toolFree:true,signal,
      messages:[{role:'system',content:systemPrompt},{role:'user',content:JSON.stringify(payload)}]});
    signal.throwIfAborted();
    return response;
  }};
}
