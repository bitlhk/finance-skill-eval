import {runtimeProcessSchema} from '../../shared/contracts/runtime-process.js';
import {canonicalSha256} from '../../shared/json-canonicalization.js';
import type {RuntimeExecutionEvidence} from '../../contracts.js';

/** Completeness is scoped: a complete event stream is not a complete tool trace. */
export function toolTraceStatus(evidence?:RuntimeExecutionEvidence):'COMPLETE'|'PARTIAL_OR_UNAVAILABLE'{
  if(evidence?.metadata?.process!==undefined){
    const parsed=runtimeProcessSchema.safeParse(evidence.metadata.process);
    return parsed.success&&parsed.data.status==='COMPLETE'&&parsed.data.scopes.includes('tools')
      ?'COMPLETE':'PARTIAL_OR_UNAVAILABLE';
  }
  const legacy=evidence?.metadata?.telemetry;
  return legacy&&typeof legacy==='object'&&'status' in legacy&&legacy.status==='COMPLETE'
    ?'COMPLETE':'PARTIAL_OR_UNAVAILABLE';
}

/** Shared validation/projection for Launcher, local execution, judges and saved reports. */
export function withRuntimeProcess(evidence:RuntimeExecutionEvidence,required=false):RuntimeExecutionEvidence{
  if(evidence.metadata.process===undefined){
    if(required)throw new Error('Runtime execute response requires metadata.process (finance.runtime-process.v1)');
    return evidence; // Historical evidence stays readable; do not invent a trajectory.
  }
  const process=runtimeProcessSchema.parse(evidence.metadata.process);
  const tools=process.records.filter(record=>record.kind==='tool');
  const terminal=tools.filter(record=>record.status!=='incomplete');
  const calls=terminal.map(record=>({name:record.name!,status:record.status as 'completed'|'failed'}));
  if(process.status==='COMPLETE'&&process.scopes.includes('tools')&&evidence.toolCalls.length
    &&canonicalSha256(calls)!==canonicalSha256(evidence.toolCalls))throw new Error('Process tool records do not match toolCalls');
  const result={...evidence,toolCalls:evidence.toolCalls.length?evidence.toolCalls:calls,metadata:{...evidence.metadata,process,
    // Keep historical richer receipts; new integrations need only provide process records.
    ...(evidence.metadata.toolEvidence===undefined?{toolEvidence:terminal.map(record=>({
      tool:record.name,status:record.status,callId:record.callId,
      ...(record.input!==undefined?{arguments:record.input,argumentsDigest:canonicalSha256(record.input)}:{}),
      ...(record.output!==undefined?{result:record.output,resultDigest:canonicalSha256(record.output)}:{resultOmitted:true}),
      ...(record.error?{error:record.error}:{}),
    }))}:{}),
  }};
  // Projections are conveniences, not grounds to discard a valid original process.
  if(evidence.metadata.toolEvidence===undefined&&Buffer.byteLength(JSON.stringify(result),'utf8')>262144)
    delete result.metadata.toolEvidence;
  return result;
}
