import {z} from 'zod';
import {createHash} from 'node:crypto';
import type {RuntimeExecutionEvidence} from '../../contracts.js';

/** An index over saved evidence, not another trace wire format. References are JSON pointers. */
export function evidenceResources(evidence:RuntimeExecutionEvidence):Record<string,unknown>{
  return {output:evidence.output,toolCalls:evidence.toolCalls,usage:evidence.usage,
    process:evidence.metadata?.process??null,
    artifacts:evidence.metadata?.artifacts??null,state:evidence.metadata?.state??null,
    telemetry:evidence.metadata?.telemetry??null,externalTelemetry:evidence.metadata?.externalTelemetry??null,toolEvidence:evidence.metadata?.toolEvidence??[],
    execution:{status:evidence.status,elapsedMs:evidence.elapsedMs,identityVerified:evidence.runtimeIdentityVerified,streamCompleted:evidence.streamCompleted,
      ...(evidence.metadata?.caseState!==undefined?{caseState:evidence.metadata.caseState}:{})}};
}
export function readEvidencePointer(value:unknown,reference:string):unknown{
  if(reference==='')return value;
  if(!reference.startsWith('/'))return undefined;
  for(const encoded of reference.slice(1).split('/')){
    const part=encoded.replace(/~1/g,'/').replace(/~0/g,'~');
    if(['__proto__','prototype','constructor'].includes(part)||value===null||typeof value!=='object'||!Object.hasOwn(value,part))return undefined;
    value=(value as Record<string,unknown>)[part];
  }
  return value;
}
export const citedCheckSchema=z.strictObject({id:z.string().min(1),status:z.enum(['PASS','FAIL','UNVERIFIED']),reason:z.string().min(1),
  evidenceRefs:z.array(z.string().min(1)).default([]),score:z.number().min(0).max(1).optional()});
export function validateCitations(checks:z.infer<typeof citedCheckSchema>[],resources:unknown){
  return checks.map(check=>{
    if(check.evidenceRefs.some(ref=>readEvidencePointer(resources,ref)==null))throw new Error('Judge cited unavailable evidence');
    return {...check,...(check.status!=='UNVERIFIED'&&!check.evidenceRefs.length?{status:'UNVERIFIED' as const,reason:'Missing evidence citations: '+check.reason}:{})};
  });
}

export function validateArtifacts(value:unknown){
  const schema=z.array(z.strictObject({path:z.string().min(1).max(500),content:z.string().max(64000).optional(),
    sha256:z.string().regex(/^[a-f0-9]{64}$/),source:z.string().min(1).max(100)})).max(32);
  const parsed=schema.safeParse(value);
  if(!parsed.success)return null;
  if(new Set(parsed.data.map(item=>item.path)).size!==parsed.data.length)return null;
  if(parsed.data.some(item=>item.content!==undefined&&createHash('sha256').update(item.content).digest('hex')!==item.sha256))return null;
  return parsed.data;
}
