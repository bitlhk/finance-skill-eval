import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { ResolvedSkillSource } from '../../direct-model-runtime.js';
import { runtimeSkillMemberSchema, type RuntimeSkillMember } from './runtime-skill-member.js';

const base64 = z.string().refine(value => /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value), 'Invalid base64 file');
export const runtimeSkillSchema = runtimeSkillMemberSchema.extend({
  instructions: z.string().min(1),
  files: z.record(base64).optional(),
});
/** Inline instructions plus optional resources; neither an archive nor a project is required. */
export const runtimeSkillSetSchema = z.strictObject({
  skills: z.array(runtimeSkillSchema).min(1).max(10),
  assets: z.record(base64).optional(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
  entryInstructionsFile: z.string().min(1).optional(),
});
export type RuntimeSkillSet = z.infer<typeof runtimeSkillSetSchema>;
export function skillMembers(set: RuntimeSkillSet) {
  return set.skills.map(({ instructions: _, files: __, ...member }) => member);
}
export function runtimeSkillSetFromFiles(input: { digest: string; members: RuntimeSkillMember[]; files: Record<string,string>; entryInstructionsFile?: string }): RuntimeSkillSet {
  const assets = { ...input.files };
  const skills = input.members.map(member => {
    const prefix = member.skillFile.slice(0, -'SKILL.md'.length);
    const files: Record<string,string> = {};
    for (const [name, content] of Object.entries(input.files)) if (name.startsWith(prefix)) {
      delete assets[name];
      if (name !== member.skillFile) files[name] = content;
    }
    if (!(member.skillFile in input.files)) throw new Error('Skill entry is missing');
    const raw = Buffer.from(input.files[member.skillFile]!, 'base64');
    const instructions = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw);
    return { ...member, instructions, ...(Object.keys(files).length ? { files } : {}) };
  });
  return runtimeSkillSetSchema.parse({ skills, ...(Object.keys(assets).length ? { assets } : {}), contentDigest: input.digest,
    ...(input.entryInstructionsFile ? { entryInstructionsFile: input.entryInstructionsFile } : {}) });
}
export function skillSetFileStats(set: RuntimeSkillSet) {
  const files = { ...set.assets };
  for (const skill of set.skills) Object.assign(files, skill.files, { [skill.skillFile]: Buffer.from(skill.instructions).toString('base64') });
  return { count: Object.keys(files).length, bytes: Object.values(files).reduce((sum,value) => sum + Buffer.from(value, 'base64').length, 0) };
}

/** Import a selected asset into the same collection model used by the task workspace. */
export async function runtimeSkillSetFromAsset(asset: ResolvedSkillSource): Promise<RuntimeSkillSet> {
  const entry = asset.skillFile ?? 'SKILL.md';
  let files: Record<string, string>;
  if (asset.archiveBase64) {
    const { unzipSync } = await import('fflate');
    const raw = Buffer.from(asset.archiveBase64, 'base64');
    if (createHash('sha256').update(raw).digest('hex') !== asset.archiveSha256) throw new Error('Asset archive digest mismatch');
    files = Object.fromEntries(Object.entries(unzipSync(raw)).filter(([name]) => !name.endsWith('/')).map(([name, bytes]) => [name, Buffer.from(bytes).toString('base64')]));
  } else files = Object.fromEntries(Object.entries({...asset.files, [entry]: asset.instructions}).map(([name, value]) => [name, Buffer.from(value).toString('base64')]));
  const digest = (selected: Record<string,string>) => {
    const hash = createHash('sha256');
    for (const name of Object.keys(selected).sort()) hash.update(name).update('\0').update(Buffer.from(selected[name]!, 'base64')).update('\0');
    return hash.digest('hex');
  };
  const prefix = entry.slice(0, -'SKILL.md'.length);
  const own = Object.fromEntries(Object.entries(files).filter(([name]) => name.startsWith(prefix)));
  return runtimeSkillSetFromFiles({digest: digest(files), files, members:[{id:'selected-skill',skillId:asset.skillId,version:asset.version,skillFile:entry,artifactSha256:digest(own)}]});
}
