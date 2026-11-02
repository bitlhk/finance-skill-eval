import type {RuntimeAdapter, RuntimeExecutionRequest} from '../../adapters.js';
import {RuntimeCaseNotExecutedError, RuntimeExecutionFailure} from '../../adapters.js';
import type {RuntimeExecutionEvidence} from '../../contracts.js';
import {EvaluationCancelledError} from '../domain/errors.js';

/** Shared execution boundary. The workflow owns instance lifetime (per case or per run). */
export async function executeEvaluationCase(input:{
  runtime:RuntimeAdapter;request:RuntimeExecutionRequest;failureMode:'throw'|'evidence';
}):Promise<RuntimeExecutionEvidence>{
  const {request}=input;
  request.signal?.throwIfAborted();
  const startedAt=Date.now();
  try{
    const evidence=await input.runtime.execute(request);
    request.signal?.throwIfAborted();
    return evidence;
  }catch(error){
    if(request.signal?.aborted||error instanceof EvaluationCancelledError||input.failureMode==='throw')throw error;
    return {
      runId:request.runId,side:request.side,caseId:request.evalCase.caseId,status:'failed',modelId:request.model.modelId,
      skillVersion:request.variant.mode==='skill_version'?request.variant.version:null,
      output:'',elapsedMs:Date.now()-startedAt,toolCalls:[],loadedSkills:[],usage:null,
      runtimeIdentityVerified:false,streamCompleted:false,error:error instanceof Error?error.message:String(error),
      metadata:error instanceof RuntimeCaseNotExecutedError
        ?{executionDisposition:'NOT_EXECUTED',blockedByCaseId:error.failedCaseId}
        :error instanceof RuntimeExecutionFailure?error.metadata:{},
    };
  }
}
