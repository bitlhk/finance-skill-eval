import {z} from 'zod';
import type {RuntimeExecutionEvidence} from './contracts.js';

const opaque=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/u);
const sha=z.string().regex(/^[a-f0-9]{64}$/u);
/** Launcher-owned subprocess observations, not OS isolation or memory attestation. */
export const runtimeToolProcessEvidenceSchema=z.strictObject({
  schemaVersion:z.literal('finance.runtime-tool-process-evidence.v1'),
  scope:z.literal('LAUNCHER_MANAGED_SCRIPT_CALLS'),caseScopeId:opaque,
  records:z.array(z.strictObject({callIndex:z.number().int().nonnegative(),tool:opaque,processScopeId:opaque,
    startedAt:z.string().datetime(),exitedAt:z.string().datetime(),exitCode:z.number().int(),
    argumentsDigest:sha,resultDigest:sha})).max(256),
});

/** Invalid or uncorrelated optional evidence never becomes a positive assertion. */
export function verifiedToolProcessEvidence(evidence:RuntimeExecutionEvidence){
  const absent={status:'NOT_COLLECTED' as const,records:[]};
  if(evidence.metadata.toolProcessEvidence===undefined)return absent;
  const invalid={status:'INVALID' as const,records:[]};
  const parsed=runtimeToolProcessEvidenceSchema.safeParse(evidence.metadata.toolProcessEvidence);
  if(!parsed.success||!evidence.runtimeIdentityVerified||!evidence.streamCompleted||evidence.status!=='completed'
    ||parsed.data.caseScopeId!==evidence.metadata.caseScopeId)return invalid;
  const facts=evidence.metadata.toolEvidence;
  if(!Array.isArray(facts))return invalid;
  const records=parsed.data.records;
  if(!records.length)return absent;
  if(new Set(records.map(r=>r.callIndex)).size!==records.length||new Set(records.map(r=>r.processScopeId)).size!==records.length)return invalid;
  for(const r of records){
    const call=evidence.toolCalls[r.callIndex],fact=facts[r.callIndex];
    if(!call||call.name!==r.tool||call.status!=='completed'||!fact||typeof fact!=='object'
      ||fact.tool!==r.tool||fact.status!=='completed'||fact.argumentsDigest!==r.argumentsDigest||fact.resultDigest!==r.resultDigest
      ||r.exitCode!==0||Date.parse(r.startedAt)>Date.parse(r.exitedAt))return invalid;
  }
  // Digests are correlation checks, not data for a model to reverse. No PID/path.
  return {status:'CORRELATED' as const,scope:parsed.data.scope,records:records.map(({callIndex,tool,processScopeId,startedAt,exitedAt,exitCode})=>
    ({callIndex,tool,processScopeId,startedAt,exitedAt,exitCode}))};
}
