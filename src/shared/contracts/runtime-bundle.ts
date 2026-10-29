import { runtimeSkillMembersSchema } from './runtime-skill-member.js';
import { z } from 'zod';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const runtimeBundleSchema = z.strictObject({
  digest,
  members: runtimeSkillMembersSchema,
  archiveBase64: z.string().min(1),
  archiveSha256: digest,
  entryInstructionsFile: z.string().min(1).optional(),
});
export type RuntimeBundle = z.infer<typeof runtimeBundleSchema>;
