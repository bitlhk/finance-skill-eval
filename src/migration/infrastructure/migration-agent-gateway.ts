import type {MigrationAnalysis,MigrationImplementation} from '../application/migration-agent-port.js';
import {configuredModelRole} from '../../service/config.js';
import {stageEnvelope} from '../domain/migration-stage-envelope.js';
import {correctModelOutput,type OutputCheck} from './model-output-correction.js';
import {
  MigrationAgentUnavailable,
  encodeArchive,
  migrationAgentEnabled,
  runMigrationAgent,
  type AgentResult,
  type MigrationAgentOptions,
} from './migration-agent-runner.js';

function checkRecoveredJudgement(stage:'A2'|'A4',value:unknown):OutputCheck<Record<string,unknown>>{
  if(!value||typeof value!=='object'||Array.isArray(value))return {ok:false,errors:['$: 需要 JSON 对象']};
  const output=value as Record<string,unknown>;
  if(output.status==='ABSTAINED')return typeof output.reason==='string'&&output.reason.trim()
    ?{ok:true,value:output}:{ok:false,errors:['reason: 弃权时需要说明原因']};
  if(output.status!=='PRODUCED')return {ok:false,errors:['status: 只能是 PRODUCED 或 ABSTAINED']};
  const errors:string[]=[];
  if(!Array.isArray(output.tools))errors.push('tools: 需要数组');
  if(stage==='A2'&&(!output.skill||typeof output.skill!=='object'||Array.isArray(output.skill)))errors.push('skill: 需要对象');
  if(stage==='A2'&&(!output.dependencyAnalysis||typeof output.dependencyAnalysis!=='object'||Array.isArray(output.dependencyAnalysis)))
    errors.push('dependencyAnalysis: 需要对象');
  return errors.length?{ok:false,errors}:{ok:true,value:output};
}

async function repairParseFailure<T>(stage:'A2'|'A4',result:AgentResult<T>,options:MigrationAgentOptions):Promise<AgentResult<T>>{
  if(result.status!=='FAILED'||!result.payload.outputParseFailed||result.payload.rawOutputTruncated||!result.payload.rawOutput)return result;
  try{
    const role=configuredModelRole(stage==='A2'?'ANALYZER':'MIGRATION');
    const corrected=await correctModelOutput({raw:result.payload.rawOutput,
      check:value=>checkRecoveredJudgement(stage,value),adapter:role.adapter,model:role.model,
      requestId:`${stage}-${result.binding.assetDigest.slice(0,16)}`,signal:options.signal});
    if(!corrected.ok)return result;
    const judgement=corrected.value as T,status=corrected.value.status==='ABSTAINED'?'ABSTAINED':'PRODUCED';
    return stageEnvelope({assetDigest:result.binding.assetDigest,stageId:stage,producer:'AGENT',status,
      payload:{...result.payload,judgement},...(result.trace?{trace:result.trace}:{}),
      run:{...(result.run?.modelId?{modelId:result.run.modelId}:{}),
        ...(result.run?.elapsedMs?{elapsedMs:result.run.elapsedMs}:{}),outputCorrectionAttempts:corrected.repairs}});
  }catch{return result}
}

/** Adapts the generic process runner to the A2 analysis application port. */
export async function analyzeWithAgent(input:{
  assetDigest:string;
  runId:string;
  files:Record<string,Uint8Array>;
  supplements?:import('../domain/migration-dependency.js').AnalysisSupplement[];
  targetRuntime?:import('../../shared/contracts/runtime-launcher.js').RuntimeLauncherCapabilities;
},options:MigrationAgentOptions):Promise<MigrationAnalysis|null>{
  if(!migrationAgentEnabled())return null;
  let result:AgentResult<{reason?:string;missing?:string[]}>;
  try{
    result=await repairParseFailure('A2',await runMigrationAgent('A2',{...input,files:encodeArchive(input.files)},options),options);
  }catch(error){
    return {status:'FAILED',reason:error instanceof MigrationAgentUnavailable?error.message:'A2 执行失败，请查看平台日志'};
  }
  if(result.status==='ABSTAINED')return {
    status:'ABSTAINED',
    reason:String(result.payload.judgement?.reason??'').trim()||'分析 agent 没有说明弃权原因',
    missing:(result.payload.judgement?.missing??[]).map(String).filter(Boolean),
    workspaceRoot:result.payload.workspaceRoot,
    libraryInventory:result.payload.libraryInventory,
    payload:result.payload.judgement&&['skill','tools','runtimeCapabilities'].some(name=>
      Object.prototype.hasOwnProperty.call(result.payload.judgement,name))?result.payload.judgement:undefined,
    scanner:result.payload.scanner,
    ...(result.run?.outputCorrectionAttempts?{outputCorrectionAttempts:result.run.outputCorrectionAttempts}:{}),
  };
  if(result.status!=='PRODUCED')return {
    status:'FAILED',
    reason:String(result.run?.error??'').trim()||'分析 agent 没有产出结果，也没有说明原因',
    failureKind:result.payload.outputParseFailed?'OUTPUT_FORMAT':'AGENT_EXECUTION',
  };
  return {
    status:'PRODUCED',
    workspaceRoot:result.payload.workspaceRoot,
    libraryInventory:result.payload.libraryInventory,
    payload:result.payload.judgement,
    scanner:result.payload.scanner??null,
    ...(result.run?.outputCorrectionAttempts?{outputCorrectionAttempts:result.run.outputCorrectionAttempts}:{}),
  };
}

/** Adapts the generic process runner to the A4 implementation application port. */
export async function implementWithAgent(input:{
  assetDigest:string;
  runId:string;
  files:Record<string,Uint8Array>;
  decisions:unknown[];
  tools:unknown[];
  contract:Record<string,unknown>;
  deliveryContract?:Record<string,unknown>;
},options:MigrationAgentOptions):Promise<MigrationImplementation|null>{
  if(!migrationAgentEnabled())return null;
  let result:AgentResult<{tools?:unknown[]}>;
  try{
    result=await repairParseFailure('A4',await runMigrationAgent('A4',{...input,files:encodeArchive(input.files)},options),options);
  }catch(error){
    return {status:'FAILED',reason:error instanceof MigrationAgentUnavailable?error.message:'A4 执行失败，请查看平台日志'};
  }
  if(result.status!=='PRODUCED'&&result.status!=='ABSTAINED')return {
    status:'FAILED',
    reason:String(result.run?.error??'').trim()||'迁移 agent 没有产出结果，也没有说明原因',
    failureKind:result.payload.outputParseFailed?'OUTPUT_FORMAT':'AGENT_EXECUTION',
  };
  return {status:result.status,payload:result.payload.judgement,files:result.payload.files??{},
    ...(result.run?.outputCorrectionAttempts?{outputCorrectionAttempts:result.run.outputCorrectionAttempts}:{})};
}
