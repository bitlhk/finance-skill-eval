import {z} from 'zod';

export const capabilityContractSchema=z.strictObject({
  inputSchema:z.record(z.unknown()),outputSchema:z.record(z.unknown()),errorSchema:z.record(z.unknown()),semantics:z.string().min(1),
});
export const capabilityConstraintsSchema=z.strictObject({
  permissions:z.array(z.string().min(1)),sideEffects:z.enum(['none','read','write']),isolation:z.string().min(1),
});
/** One enum wrapped in an array has exactly the same meaning; multiple values do not. */
export function normalizeCapabilityConstraints(value:unknown):unknown{
  if(!value||typeof value!=='object'||Array.isArray(value))return value;
  const fields=value as Record<string,unknown>;
  const candidate=Array.isArray(fields.sideEffects)&&fields.sideEffects.length===1?fields.sideEffects[0]:fields.sideEffects;
  const normalized=typeof candidate==='string'?candidate.trim().toLowerCase():candidate;
  return typeof normalized==='string'&&['none','read','write'].includes(normalized)
    ?{...fields,sideEffects:normalized}:value;
}
/** Advertised behavior, not a permission grant or an evaluation verdict. */
export const nativeCapabilitySchema=z.strictObject({
  capabilityId:z.string().min(1),name:z.string().min(1),contract:capabilityContractSchema,constraints:capabilityConstraintsSchema,
});
