import { createHash } from 'node:crypto';
import { zipSync } from 'fflate';
import type { ResolvedSkillSource } from './direct-model-runtime.js';

/** Preserve the verified asset tree, including sibling MCP projects. No path aliases. */
export function runtimeSkillPackage(input: {
  skillId:string; version:string; artifactSha256:string; skillFile:string;
  archive:Record<string,Uint8Array>;
}):ResolvedSkillSource & {files:Record<string,string>} {
  const entry=input.archive[input.skillFile];
  if(!entry)throw new Error('Runtime Skill document is missing from its archive');
  const instructions=new TextDecoder('utf-8',{fatal:true}).decode(entry);
  const files:Record<string,string>={};
  for(const [name,bytes] of Object.entries(input.archive)){
    try{files[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
    catch{/* Binary files remain in the verified archive for capable Launchers. */}
  }
  const archive=Buffer.from(zipSync(input.archive));
  return {skillId:input.skillId,version:input.version,artifactSha256:input.artifactSha256,instructions,
    ...(input.skillFile==='SKILL.md'?{}:{skillFile:input.skillFile}),files,
    archiveBase64:archive.toString('base64'),archiveSha256:createHash('sha256').update(archive).digest('hex')};
}
