import type { RuntimeAdapter } from '../../adapters.js';
import type { EvalCase, ModelRef, RuntimeExecutionEvidence } from '../../contracts.js';
import type {
  BundleAnalysis,
  BundleConfiguration,
  BundleDelivery,
  BundleSnapshot,
  BundleVerdict,
} from './bundle-model.js';
export type BundleAgentInput = {
  mode: 'ANALYZE' | 'GENERATE' | 'REPAIR';
  source: BundleSnapshot;
  base: BundleSnapshot;
  goal: string;
  target: string;
  analysis?: BundleAnalysis;
  feedback?: unknown;
  signal: AbortSignal;
};
export type BundleAgentResult = {
  status: 'PRODUCED' | 'ABSTAINED';
  reason?: string;
  analysis?: BundleAnalysis;
  delivery?: BundleDelivery;
  files?: Record<string, string>;
};
export type BundleAgent = (input: BundleAgentInput) => Promise<BundleAgentResult>;
export type BundleExecution = { runtime: RuntimeAdapter; model: ModelRef; environmentSnapshot: unknown };
export type BundleRuntimeFactory = (input: {
  snapshot: BundleSnapshot;
  services: BundleDelivery['services'];
  configuration: BundleConfiguration;
  signal: AbortSignal;
}) => Promise<BundleExecution>;
export type BundleJudge = (input: {
  evalCase: EvalCase;
  evidence: RuntimeExecutionEvidence;
  signal: AbortSignal;
}) => Promise<BundleVerdict>;
