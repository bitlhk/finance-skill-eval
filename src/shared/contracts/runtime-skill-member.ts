import { z } from 'zod';
export const runtimeSkillMemberSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9-]+$/), skillId: z.string().min(1),
  skillFile: z.string().min(1), version: z.string().min(1),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export const runtimeSkillMembersSchema = z.array(runtimeSkillMemberSchema).min(1).max(10);
export type RuntimeSkillMember = z.infer<typeof runtimeSkillMemberSchema>;
