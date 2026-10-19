import { z } from 'zod';
import { runtimeSkillMembersSchema } from './runtime-skill-member.js';

const legacyTaskBuildProfileSchema = z.strictObject({
  schemaVersion: z.literal('finance.migration-task-build-profile.v1'), required: z.literal(true),
  taskId: z.string().min(1), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  candidateId: z.string().min(1), candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  members: runtimeSkillMembersSchema, goal: z.string().min(1), target: z.string().min(1),
  analysis: z.unknown().optional(),
  instanceSchemaVersion: z.literal('finance.skill-eval.runtime-instance.v2'), multiSkill: z.literal(true),
  settings: z.strictObject({ modelId: z.string().min(1).optional(), timeoutMs: z.number().int().min(10000).max(900000),
    entryInstructionsFile: z.string().min(1).optional(), harnessTools: z.array(z.enum(['read_file', 'glob', 'list_files', 'bash'])).max(4) }),
  services: z.array(z.strictObject({ toolNames: z.array(z.string().min(1)).min(1), filePaths: z.array(z.string().min(1)).min(1),
    start: z.array(z.string().min(1)).min(1).max(100), prepare: z.array(z.string()).max(100).optional() })).max(20),
  files: z.array(z.string().min(1)).min(1).max(1000),
});

export const taskBuildProfileSchema = legacyTaskBuildProfileSchema.omit({schemaVersion:true,members:true}).extend({
  schemaVersion: z.literal('finance.migration-task-build-profile.v2'), skills: runtimeSkillMembersSchema,
});
export const compatibleTaskBuildProfileSchema = z.union([taskBuildProfileSchema,legacyTaskBuildProfileSchema]).transform(profile =>
  'members' in profile ? {...profile,skills:profile.members} : profile);

/** Mandatory receipt within the existing Builder v1 extension envelope. */
export const taskBuildReceiptSchema = z.strictObject({
  schemaVersion: z.enum(['finance.migration-task-build-receipt.v1','finance.migration-task-build-receipt.v2']),
  taskId: z.string().min(1), candidateId: z.string().min(1),
  candidateDigest: z.string().regex(/^[a-f0-9]{64}$/),
  instanceSchemaVersion: z.literal('finance.skill-eval.runtime-instance.v2'),
});
