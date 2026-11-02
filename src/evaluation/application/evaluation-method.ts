import type {EvalCase, RuntimeExecutionEvidence} from '../../contracts.js';
import type {EvidenceCheck} from '../domain/execution-checks.js';

export type EvaluationMethodInput={evalCase:EvalCase;evidence:RuntimeExecutionEvidence;signal?:AbortSignal};
/** Scripts, state verifiers and Judge Agents implement the same method boundary. */
export type EvaluationMethod={
  id:string;version:string;kind:'RULE'|'SCRIPT'|'STATE'|'AGENT';
  evaluate(input:EvaluationMethodInput):Promise<EvidenceCheck[]>|EvidenceCheck[];
};
export type EvaluationMethodResult={methodId:string;version:string;kind:EvaluationMethod['kind'];
  status:'PASS'|'FAIL'|'UNVERIFIED';checks:EvidenceCheck[]};

/** Keep every method's evidence. A high model score cannot override a failed mandatory check. */
export async function evaluateMethods(input:EvaluationMethodInput,methods:ReadonlyArray<EvaluationMethod>):Promise<EvaluationMethodResult[]>{
  if(new Set(methods.map(m=>m.id)).size!==methods.length)throw new Error('Duplicate evaluation method');
  const results:EvaluationMethodResult[]=[];
  for(const method of methods){
    input.signal?.throwIfAborted();
    const checks=await method.evaluate(input);
    input.signal?.throwIfAborted();
    if(new Set(checks.map(c=>c.id)).size!==checks.length)throw new Error('Duplicate evaluation check');
    results.push({methodId:method.id,version:method.version,kind:method.kind,checks,
      status:checks.some(c=>c.status==='FAIL')?'FAIL':!checks.length||checks.some(c=>c.status==='UNVERIFIED')?'UNVERIFIED':'PASS'});
  }
  return results;
}
