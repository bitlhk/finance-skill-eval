import {z} from 'zod';

/** A versioned test-environment fixture, not a business tool or an arbitrary reset command. */
export const caseStateFixtureSchema=z.strictObject({
  fixtureId:z.string().min(1).max(100),version:z.string().min(1).max(100),
  initialStateDigest:z.string().regex(/^[a-f0-9]{64}$/),
});
export const caseStateRequestSchema=z.strictObject({
  schemaVersion:z.literal('finance.case-state.v1'),operationId:z.string().uuid(),
  runId:z.string().min(1),caseId:z.string().min(1),side:z.enum(['left','right']),
  fixture:caseStateFixtureSchema,phase:z.enum(['prepare','capture','restore']),
});
export const caseStateReceiptSchema=caseStateRequestSchema.extend({
  status:z.enum(['SUCCEEDED','FAILED','UNAVAILABLE']),
  stateDigest:z.string().regex(/^[a-f0-9]{64}$/).optional(),state:z.record(z.unknown()).optional(),
  message:z.string().max(2000).optional(),
});
export type CaseStateRequest=z.infer<typeof caseStateRequestSchema>;
export type CaseStateReceipt=z.infer<typeof caseStateReceiptSchema>;
export type CaseStateFixture=z.infer<typeof caseStateFixtureSchema>;
