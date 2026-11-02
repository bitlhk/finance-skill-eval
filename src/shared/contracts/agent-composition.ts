import {z} from 'zod';

/** Execution provenance only: no prompts, task contents, endpoint URLs or credentials. */
export type AgentCompositionReceipt = {
  schemaVersion: 'finance.agent-composition.v1';
  role: string;
  version: string;
  configurationSource: 'REQUEST' | 'RESOLVED';
  definitionDigest: string;
  resources: Array<{ path: string; sha256: string }>;
  tools: string[];
  writeScope: 'none' | 'candidate';
  inputDigest: string;
  model: { providerId: string; modelId: string; configurationDigest: string };
  budget: { kind: 'agentIterations' | 'singleCompletion'; maxIterations?: number; timeoutMs: number; maxTokens?: number };
};

const digest=z.string().regex(/^[a-f0-9]{64}$/u);
export const agentCompositionReceiptSchema:z.ZodType<AgentCompositionReceipt>=z.strictObject({
  schemaVersion:z.literal('finance.agent-composition.v1'),role:z.string().min(1),version:z.string().min(1),
  configurationSource:z.enum(['REQUEST','RESOLVED']),definitionDigest:digest,
  resources:z.array(z.strictObject({path:z.string().min(1),sha256:digest})),tools:z.array(z.string()),
  writeScope:z.enum(['none','candidate']),inputDigest:digest,
  model:z.strictObject({providerId:z.string(),modelId:z.string(),configurationDigest:digest}),
  budget:z.strictObject({kind:z.enum(['agentIterations','singleCompletion']),maxIterations:z.number().int().positive().optional(),
    timeoutMs:z.number().int().positive(),maxTokens:z.number().int().positive().optional()}),
});
