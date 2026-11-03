import type {EvalCase,RuntimeExecutionEvidence} from '../../../contracts.js';
import type {BundleJudge} from './task-ports.js';
import type {EvidenceCheck} from '../../../evaluation/domain/execution-checks.js';
import {evaluateMethods} from '../../../evaluation/application/evaluation-method.js';
import {plannedMethods} from '../../../evaluation/application/planned-methods.js';

/** Both live acceptance and offline rescoring evaluate the same frozen case evidence. */
export async function evaluateTaskCase(input:{
  evalCase:EvalCase;evidence:RuntimeExecutionEvidence;signal:AbortSignal;
  executionChecks:EvidenceCheck[];judge:BundleJudge;judgeInput:Omit<Parameters<BundleJudge>[0],'evalCase'|'evidence'|'signal'>;
}){
  let verdict:Awaited<ReturnType<BundleJudge>>={passed:false,unverified:true,reason:'执行未完成，或整组装载证据不完整'};
  const methodResults=await evaluateMethods(input,[{
    id:'bundle-execution',version:'1',kind:'RULE',evaluate:()=>input.executionChecks,
  },{
    id:'business-judge',version:input.judge.identity?.()??'1',kind:'MODEL',dependsOn:['bundle-execution'],timeoutMs:input.judge.timeoutMs?.()??120000,
    evaluate:async({evalCase,evidence,signal})=>{
      let result:Awaited<ReturnType<BundleJudge>>;
      try {
        result=await input.judge({...input.judgeInput,evalCase,evidence,signal:signal!});
      } catch(error) {
        if(signal?.aborted||(error as {code?:string})?.code!=='MODEL_NETWORK_ERROR')throw error;
        result=await input.judge({...input.judgeInput,evalCase,evidence,signal:signal!});
      }
      signal!.throwIfAborted();verdict=result;
      return result.criteria?.map(c=>({id:c.id,status:c.passed===null?'UNVERIFIED' as const:c.passed?'PASS' as const:'FAIL' as const,reason:c.reason,evidenceRefs:c.evidenceRefs}))
        ??[{id:'business',status:result.unverified?'UNVERIFIED':result.passed?'PASS':'FAIL',reason:result.reason}];
    },
  },...plannedMethods(input.evalCase.evaluationPlan)]);
  const valid=methodResults[0]!.status==='PASS';
  const judgeFailed=methodResults[1]!.status==='ERROR';
  let incomplete=!valid||judgeFailed||methodResults[1]!.checks.some(check=>check.status==='UNVERIFIED');
  if(judgeFailed)verdict={passed:false,unverified:true,reason:methodResults[1]!.reason??'评判失败'};
  for(const check of input.evalCase.evaluationPlan?.checks??[]){
    const result=methodResults.find(method=>method.methodId==='plan:'+check.id)!;
    if(check.required&&result.status!=='PASS'){
      verdict={...verdict,passed:false,reason:verdict.reason+'\n'+check.id+': '+(result.reason??result.checks.map(c=>c.reason).join('; '))};
      if(result.status!=='FAIL'||result.checks.some(check=>check.status==='UNVERIFIED'))incomplete=true;
    }
  }
  return {verdict,methodResults,valid,judgeFailed,incomplete};
}
