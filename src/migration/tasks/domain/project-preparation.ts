import { z } from 'zod';

/** Reusable engineering report; execution receipts come from the runner, never the model. */
export const projectPreparationSchema = z.strictObject({
  summary: z.string().min(1),
  skills: z.array(z.strictObject({ path: z.string().min(1), usage: z.string().min(1) })),
  entrypoints: z.array(z.string()),
  missing: z.array(z.string()),
  baselinePlan: z.string().min(1),
});
export const projectExecutionReceiptSchema = z.strictObject({
  command: z.array(z.string()), cwd: z.string(),
  status: z.enum(['COMPLETED', 'FAILED', 'UNAVAILABLE', 'TIMEOUT']),
  exitCode: z.number().int().nullable(), output: z.string(),
  snapshotDigest: z.string(),
});
export type ProjectPreparation = z.infer<typeof projectPreparationSchema>;
export type ProjectExecutionReceipt = z.infer<typeof projectExecutionReceiptSchema>;
