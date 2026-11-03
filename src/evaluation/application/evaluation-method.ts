import type {EvalCase, RuntimeExecutionEvidence} from '../../contracts.js';
import type {EvidenceCheck} from '../domain/execution-checks.js';
import {canonicalSha256} from '../../shared/json-canonicalization.js';

export type EvaluationMethodInput={evalCase:EvalCase;evidence:RuntimeExecutionEvidence;signal?:AbortSignal};
/** Scripts, state verifiers and Judge Agents implement the same method boundary. */
export type EvaluationMethod={
  id:string;version:string;kind:'RULE'|'SCRIPT'|'STATE'|'MODEL'|'AGENT';
  timeoutMs?:number;
  /** These dependencies must pass before this method can inspect the execution. */
  dependsOn?:ReadonlyArray<string>;
  evaluate(input:EvaluationMethodInput):Promise<EvidenceCheck[]>|EvidenceCheck[];
};
export type EvaluationMethodResult={methodId:string;version:string;kind:EvaluationMethod['kind'];
  status:'PASS'|'FAIL'|'UNVERIFIED'|'ERROR'|'SKIP';checks:EvidenceCheck[];reason?:string;
  evidenceDigest?:string;startedAt?:string;durationMs?:number};

/** Keep every method's evidence. A high model score cannot override a failed mandatory check. */
export async function evaluateMethods(input:EvaluationMethodInput,methods:ReadonlyArray<EvaluationMethod>):Promise<EvaluationMethodResult[]>{
  if(new Set(methods.map(m=>m.id)).size!==methods.length)throw new Error('Duplicate evaluation method');
  const preceding=new Set<string>();
  for(const method of methods){
    if(method.dependsOn?.some(id=>!preceding.has(id)))throw new Error('Evaluation dependencies must precede their consumer');
    if(method.timeoutMs!==undefined&&(!Number.isFinite(method.timeoutMs)||method.timeoutMs<=0))throw new Error('Invalid evaluation timeout');
    preceding.add(method.id);
  }
  const results:EvaluationMethodResult[]=[];
  for(const method of methods){
    input.signal?.throwIfAborted();
    const started=Date.now();
    const identity={methodId:method.id,version:method.version,kind:method.kind,evidenceDigest:canonicalSha256(JSON.parse(JSON.stringify(input.evidence))),startedAt:new Date(started).toISOString()};
    if(method.dependsOn?.some(id=>results.find(r=>r.methodId===id)?.status!=='PASS')){
      results.push({...identity,status:'SKIP',checks:[],reason:'Required evaluation method did not pass'});
      continue;
    }
    const controller=new AbortController();
    const abort=()=>controller.abort(input.signal?.reason);
    input.signal?.addEventListener('abort',abort,{once:true});
    let timer:ReturnType<typeof setTimeout>|undefined;
    let rejectAbort:()=>void=()=>{};
    try{
    const interrupted=new Promise<never>((_,reject)=>{
      rejectAbort=()=>reject(controller.signal.reason);
      controller.signal.addEventListener('abort',rejectAbort,{once:true});
      timer=setTimeout(()=>controller.abort(new Error('Evaluation method timed out')),method.timeoutMs??60_000);
    });
    // Evaluators receive an isolated snapshot and must honour cancellation for external work.
    const checks=await Promise.race([Promise.resolve().then(()=>{
      controller.signal.throwIfAborted();
      return method.evaluate({evalCase:structuredClone(input.evalCase),evidence:structuredClone(input.evidence),signal:controller.signal});
    }),interrupted]);
    input.signal?.throwIfAborted();
    if(new Set(checks.map(c=>c.id)).size!==checks.length)throw new Error('Duplicate evaluation check');
    results.push({...identity,checks,
      status:checks.some(c=>c.status==='FAIL')?'FAIL':!checks.length||checks.some(c=>c.status==='UNVERIFIED')?'UNVERIFIED':'PASS'});
    }catch(error){
      input.signal?.throwIfAborted();
      results.push({...identity,status:'ERROR',checks:[],reason:error instanceof Error?error.message:'Evaluation method failed'});
    }finally{
      const result=results.at(-1);if(result?.methodId===method.id)result.durationMs=Date.now()-started;
      clearTimeout(timer);
      input.signal?.removeEventListener('abort',abort);
      controller.signal.removeEventListener('abort',rejectAbort);
    }
  }
  return results;
}
