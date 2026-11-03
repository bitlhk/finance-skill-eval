import type {RuntimeAdapter, RuntimeExecutionRequest} from '../../adapters.js';
import {RuntimeCaseNotExecutedError, RuntimeExecutionFailure} from '../../adapters.js';
import type {RuntimeExecutionEvidence} from '../../contracts.js';
import {EvaluationCancelledError} from '../domain/errors.js';
import {validateTelemetry} from '../domain/telemetry.js';
import {validateArtifacts} from '../domain/evidence-resources.js';
import {validateCaseState} from '../domain/case-state-evidence.js';
import {withRuntimeProcess} from '../domain/runtime-process.js';

/** Shared execution boundary. The workflow owns instance lifetime (per case or per run). */
export async function executeEvaluationCase(input:{
  runtime:RuntimeAdapter;request:RuntimeExecutionRequest;failureMode:'throw'|'evidence';
}):Promise<RuntimeExecutionEvidence>{
  const {request}=input;
  request.signal?.throwIfAborted();
  const startedAt=Date.now();
  try{
    if(request.evalCase.stateFixture&&input.runtime.supportsCaseState?.(request)!==true)
      throw new RuntimeExecutionFailure('Runtime 未提供业务初态与恢复能力，未执行此案例',{
        executionDisposition:'NOT_EXECUTED',caseState:{status:'UNAVAILABLE',reason:'STATE_LIFECYCLE_UNAVAILABLE'}});
    // Evaluator programs are grading material, never runtime task instructions.
    const {evaluationPlan:_plan,...executionCase}=request.evalCase;
    const evidence=withRuntimeProcess(await input.runtime.execute(_plan?{...request,evalCase:executionCase}:request));
    if(request.evalCase.stateFixture){
      const state=validateCaseState(evidence.metadata.caseState,request,
        evidence.metadata.candidateAssessmentReused===true&&evidence.metadata.candidateAssessmentSourceSide==='right'?'right':request.side);
      evidence.metadata.caseState=state;
      evidence.metadata.state=state.status==='COMPLETE'&&'receipts' in state?state.receipts.find(r=>r.phase==='capture')?.state??null:null;
    }
    const evidenceSide=evidence.metadata.candidateAssessmentReused===true&&evidence.metadata.candidateAssessmentSourceSide==='right'?'right':request.side;
    for(const field of ['telemetry','externalTelemetry'])if(evidence.metadata[field]!==undefined)
      evidence.metadata[field]=validateTelemetry(evidence.metadata[field],{runId:request.runId,caseId:request.evalCase.caseId,side:evidenceSide});
    if(evidence.metadata.artifacts!==undefined){
      const artifacts=validateArtifacts(evidence.metadata.artifacts);
      evidence.metadata.artifacts=artifacts;
      evidence.metadata.artifactValidation=artifacts===null?'INVALID':'VERIFIED_DIGESTS';
    }
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
