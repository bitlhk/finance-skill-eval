import { z } from 'zod';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const runtimeBundleSchema = z.strictObject({
  digest,
  members: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9-]+$/),
        skillId: z.string().min(1),
        skillFile: z.string().min(1),
        version: z.string().min(1),
        artifactSha256: digest,
      }),
    )
    .min(1)
    .max(10),
  archiveBase64: z.string().min(1),
  archiveSha256: digest,
  entryInstructionsFile: z.string().min(1).optional(),
});
export type RuntimeBundle = z.infer<typeof runtimeBundleSchema>;
