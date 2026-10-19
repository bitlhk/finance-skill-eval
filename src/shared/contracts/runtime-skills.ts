import { z } from 'zod';
import { createHash } from 'node:crypto';
import type { RuntimeBundle } from './runtime-bundle.js';
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
/** Compatibility for callers holding an old frozen ZIP; emitted requests are always inline v2. */
export async function legacyBundleToSkills(bundle: RuntimeBundle): Promise<RuntimeSkillSet> {
  const { unzipSync } = await import('fflate');
  const archive = Buffer.from(bundle.archiveBase64, 'base64');
  if (createHash('sha256').update(archive).digest('hex') !== bundle.archiveSha256) throw new Error('Archive digest mismatch');
  return runtimeSkillSetFromFiles({ ...bundle, files: Object.fromEntries(Object.entries(unzipSync(archive)).map(([p,b]) => [p,Buffer.from(b).toString('base64')])) });
}
