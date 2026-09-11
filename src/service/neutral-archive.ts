import { fingerprint, stableJson } from '../contracts.js';

/** Inert full-archive transport, allowed only for the server-configured native Host. */
export function nativeTransportAllowed(endpoint:string, configured=process.env.FINANCE_MIGRATION_NATIVE_ENDPOINT) {
  if(!configured)return false;
  try{return new URL(endpoint).href===new URL(configured).href;}catch{return false;}
}

export function canonicalNeutralArchive(files:Record<string,Uint8Array>,expectedDigest:string) {
  const entries=Object.entries(files).sort(([a],[b])=>a.localeCompare(b))
    .map(([name,content])=>({name,content:Buffer.from(content).toString('base64')}));
  if(fingerprint(entries)!==expectedDigest)throw new Error('Skill snapshot integrity mismatch');
  const raw=files['migration-generated/neutral-contract.json'];
  if(!raw)throw new Error('Neutral declaration required');
  const contract=JSON.parse(Buffer.from(raw).toString('utf8'));
  if(!contract||contract.mappingReview?.approved!==true||typeof contract.method!=='string'||!files[contract.method])
    throw new Error('Neutral mapping review required');
  if(!Array.isArray(contract.capabilities)||!contract.capabilities.length||contract.capabilities.some((c:any)=>
    typeof c?.name!=='string'||!c.inputSchema||!c.outputSchema))throw new Error('Unresolved capability schemas');
  if(!Array.isArray(contract.resources)||contract.resources.some((r:any)=>
    typeof r?.path!=='string'||!files[r.path]||!['METHOD_CONTEXT','TOOL_ONLY'].includes(r.visibility)))
    throw new Error('Unresolved resource mapping');
  return stableJson(entries);
}
