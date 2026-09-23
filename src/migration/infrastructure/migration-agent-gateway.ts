import type {MigrationAnalysis,MigrationImplementation} from '../application/migration-agent-port.js';
import {
  MigrationAgentUnavailable,
  encodeArchive,
  migrationAgentEnabled,
  runMigrationAgent,
  type AgentResult,
  type MigrationAgentOptions,
} from './migration-agent-runner.js';

/** Adapts the generic process runner to the A2 analysis application port. */
export async function analyzeWithAgent(input:{
  assetDigest:string;
  runId:string;
  files:Record<string,Uint8Array>;
  supplements?:import('../domain/migration-dependency.js').AnalysisSupplement[];
},options:MigrationAgentOptions):Promise<MigrationAnalysis|null>{
  if(!migrationAgentEnabled())return null;
  let result:AgentResult<{reason?:string;missing?:string[]}>;
  try{
    result=await runMigrationAgent('A2',{...input,files:encodeArchive(input.files)},options);
  }catch(error){
    return {status:'FAILED',reason:error instanceof MigrationAgentUnavailable?error.message:'A2 执行失败，请查看平台日志'};
  }
  if(result.status==='ABSTAINED')return {
    status:'ABSTAINED',
    reason:String(result.payload.judgement?.reason??'').trim()||'分析 agent 没有说明弃权原因',
    missing:(result.payload.judgement?.missing??[]).map(String).filter(Boolean),
    workspaceRoot:result.payload.workspaceRoot,
    libraryInventory:result.payload.libraryInventory,
    payload:result.payload.judgement,
    scanner:result.payload.scanner,
  };
  if(result.status!=='PRODUCED')return {
    status:'FAILED',
    reason:String(result.run?.error??'').trim()||'分析 agent 没有产出结果，也没有说明原因',
  };
  return {
    status:'PRODUCED',
    workspaceRoot:result.payload.workspaceRoot,
    libraryInventory:result.payload.libraryInventory,
    payload:result.payload.judgement,
    scanner:result.payload.scanner??null,
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
    result=await runMigrationAgent('A4',{...input,files:encodeArchive(input.files)},options);
  }catch(error){
    return {status:'FAILED',reason:error instanceof MigrationAgentUnavailable?error.message:'A4 执行失败，请查看平台日志'};
  }
  if(result.status!=='PRODUCED'&&result.status!=='ABSTAINED')return {
    status:'FAILED',
    reason:String(result.run?.error??'').trim()||'迁移 agent 没有产出结果，也没有说明原因',
  };
  return {status:result.status,payload:result.payload.judgement,files:result.payload.files??{}};
}
