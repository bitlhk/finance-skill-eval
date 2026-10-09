import type {ModelAdapter} from '../../adapters.js';
import type {ModelRef} from '../../contracts.js';
import {OpenAiCompatibleModelAdapter} from '../../openai-compatible-model.js';
import {parseFirstJsonObject} from '../../json-response.js';

export type OutputCheck<T>={ok:true;value:T}|{ok:false;errors:string[]};
export type OutputCorrection<T>={ok:true;value:T;repairs:number}|{ok:false;error:string;repairs:number};

/** Repair the answer only. The repair endpoint has no agent workspace or tool registry. */
export async function correctModelOutput<T>(input:{
  raw:string;check:(value:unknown)=>OutputCheck<T>;
  adapter:ModelAdapter|null;model:ModelRef;requestId:string;signal?:AbortSignal;
  maxRepairs?:number;preserve?:(original:unknown,repaired:unknown)=>boolean;
}):Promise<OutputCorrection<T>>{
  let candidate=input.raw,original:unknown;
  const maxRepairs=Math.max(0,Math.min(input.maxRepairs??2,2));
  for(let attempt=0;attempt<=maxRepairs;attempt++){
    input.signal?.throwIfAborted();
    let errors:string[];
    try{
      const parsed=parseFirstJsonObject(candidate);
      if(attempt===0)original=parsed;
      if(attempt>0&&original!==undefined&&input.preserve&&!input.preserve(original,parsed))
        return {ok:false,error:'纠错结果改变了原始判断或证据',repairs:attempt};
      const checked=input.check(parsed);
      if(checked.ok)return {ok:true,value:checked.value,repairs:attempt};
      errors=checked.errors;
    }catch(error){errors=[error instanceof Error?error.message:String(error)];}
    if(attempt===maxRepairs)return {ok:false,error:errors.join('；'),repairs:attempt};
    // Codex CLI can access a read-only workspace. It is not a tool-free repair channel.
    if(!(input.adapter instanceof OpenAiCompatibleModelAdapter))
      return {ok:false,error:errors.join('；'),repairs:attempt};
    // Truncated answers cannot be safely reconstructed. Avoid echoing them into logs.
    if(candidate.length>64_000||input.raw.length>64_000)
      return {ok:false,error:'模型输出过长，无法安全纠错',repairs:attempt};
    const completion=await input.adapter.complete({requestId:`${input.requestId}-format-${attempt+1}`,model:input.model,
      responseFormat:'json',toolFree:true,signal:input.signal,messages:[
        {role:'system',content:'仅修正给定结果的 JSON 表示和字段类型。不得调用工具、重新诊断、增加事实或证据、改变能力归属或业务结论。若原结果缺少必要事实，返回 {"status":"ABSTAINED","reason":"原结果缺少可核实的信息"}。只输出一个 JSON 对象。'},
        {role:'user',content:JSON.stringify({originalOutput:input.raw,currentOutput:candidate,validationErrors:errors.slice(0,16)})},
      ]});
    candidate=completion.content;
  }
  return {ok:false,error:'模型输出无法纠错',repairs:maxRepairs};
}
