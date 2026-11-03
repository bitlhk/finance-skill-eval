import {randomUUID} from 'node:crypto';
import type {RuntimeExecutionRequest} from '../../adapters.js';
import {RuntimeExecutionFailure} from '../../adapters.js';
import type {RuntimeExecutionEvidence} from '../../contracts.js';
import {canonicalSha256} from '../../shared/json-canonicalization.js';
import {caseStateReceiptSchema,type CaseStateRequest,type CaseStateReceipt} from '../../shared/contracts/case-state.js';

export type CaseStateEvidence={version:'1';operationId:string;fixture:NonNullable<RuntimeExecutionRequest['evalCase']['stateFixture']>;
  status:'COMPLETE'|'INCOMPLETE';receipts:CaseStateReceipt[];errors:Array<{phase:string;message:string}>};
export type CaseStatePort=(request:CaseStateRequest,signal:AbortSignal)=>Promise<unknown>;

async function stateResponse(port:CaseStatePort,input:CaseStateRequest,signal:AbortSignal){
  signal.throwIfAborted();
  let abort=()=>{};
  const cancelled=new Promise<never>((_,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});});
  try{return await Promise.race([port(input,signal),cancelled]);}
  finally{signal.removeEventListener('abort',abort);}
}

/** One business invocation, with environment capture and restoration even on failure/cancellation. */
export async function executeWithCaseState(request:RuntimeExecutionRequest,port:CaseStatePort,
  execute:()=>Promise<RuntimeExecutionEvidence>,onFinished?:(record:CaseStateEvidence)=>void){
  request.signal?.throwIfAborted();
  const fixture=request.evalCase.stateFixture!;
  const record:CaseStateEvidence={version:'1',operationId:randomUUID(),fixture,status:'INCOMPLETE',receipts:[],errors:[]};
  const action=async(phase:CaseStateRequest['phase'],signal:AbortSignal)=>{
    const input:CaseStateRequest={schemaVersion:'finance.case-state.v1',operationId:record.operationId,
      runId:request.runId,caseId:request.evalCase.caseId,side:request.side,fixture,phase};
    try{
      signal.throwIfAborted();
      const receipt=caseStateReceiptSchema.parse(await stateResponse(port,input,signal));
      for(const key of ['operationId','runId','caseId','side','phase'] as const)if(receipt[key]!==input[key])throw new Error('State receipt correlation mismatch');
      if(canonicalSha256(receipt.fixture)!==canonicalSha256(fixture))throw new Error('State fixture mismatch');
      if(receipt.state!==undefined&&canonicalSha256(receipt.state)!==receipt.stateDigest)throw new Error('State content digest mismatch');
      record.receipts.push(receipt);
      if(receipt.status!=='SUCCEEDED')throw new Error(receipt.message??'State operation did not succeed');
      if(!receipt.stateDigest)throw new Error('State operation omitted digest');
      if(phase==='capture'&&receipt.state===undefined)throw new Error('Final business state was not captured');
      if(phase!=='capture'&&receipt.stateDigest!==fixture.initialStateDigest)throw new Error('Initial/restored business state does not match fixture');
      return receipt;
    }catch(error){record.errors.push({phase,message:error instanceof Error?error.message:'State operation failed'});throw error;}
  };
  let evidence:RuntimeExecutionEvidence|undefined;
  let failure:unknown;
  const activeSignal=request.signal?AbortSignal.any([request.signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
  try{
    await action('prepare',activeSignal);
    evidence=await execute();
  }catch(error){failure=error;}
  finally{
    // Observation and restoration have a separate bounded budget: cancellation is not rollback.
    try{await action('capture',AbortSignal.timeout(10000));}catch{}
    try{await action('restore',AbortSignal.timeout(10000));}catch{}
    record.status=record.errors.length?'INCOMPLETE':'COMPLETE';
    onFinished?.(record);
  }
  if(failure||!evidence)throw new RuntimeExecutionFailure(failure instanceof Error?failure.message:'Business execution unavailable',{caseState:record});
  const captured=record.receipts.find(r=>r.phase==='capture'&&r.status==='SUCCEEDED');
  return {...evidence,metadata:{...evidence.metadata,caseState:record,...(captured?.state?{state:captured.state}:{})}};
}
