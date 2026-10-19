import type { RuntimeAdapter } from '../../../adapters.js';
import type { EvalCase, ModelRef, RuntimeExecutionEvidence } from '../../../contracts.js';
import type {
  BundleTask,
  BundleAnalysis,
  BundleConfiguration,
  BundleDelivery,
  BundleSnapshot,
  BundleVerdict,
  TaskBuildRequest,
} from '../domain/task-model.js';
import type { RuntimeBuildResultV1 } from '../../../shared/contracts/runtime-builder.js';
import type { RuntimeLauncherBinding } from '../../../shared/contracts/environment.js';
export interface TaskBuilderPort {
  accept(input: { request: TaskBuildRequest; result: RuntimeBuildResultV1; trustReference: string; name?: string;
    snapshot: BundleSnapshot; services: BundleDelivery['services'] }): Promise<{
      configuration: BundleConfiguration; environmentSnapshot: unknown; launcher: RuntimeLauncherBinding;
    }>;
}
export type MigrationCorrelation = { taskId: string; attemptId: string; requestId?: string; agentRunId: string; };
export type BundleAgentInput = {
  correlation?: MigrationCorrelation;
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
export type BundleExecution = { runtime: RuntimeAdapter; model: ModelRef; environmentSnapshot: unknown; };
export type BundleRuntimeFactory = (input: {
  snapshot: BundleSnapshot;
  services: BundleDelivery['services'];
  configuration: BundleConfiguration;
  signal: AbortSignal;
}) => Promise<BundleExecution>;
export type BundleJudge = (input: {
  correlation?: { taskId: string; attemptId: string; runId: string; requestId?: string; };
  evalCase: EvalCase;
  evidence: RuntimeExecutionEvidence;
  signal: AbortSignal;
}) => Promise<BundleVerdict>;

export interface MigrationTaskRepository {
  list(): Promise<BundleTask[]>;
  get(id: string): Promise<BundleTask>;
  readSnapshot(id: string, candidateId: string | null): Promise<BundleSnapshot>;
  update(id: string, change: (task: BundleTask) => void | Promise<void>): Promise<BundleTask>;
  save(task: BundleTask): Promise<void>;
  saveSnapshot(id: string, revision: string, snapshot: BundleSnapshot): Promise<void>;
}
export interface MigrationSourceAssets {
  get(id: string): Promise<unknown>;
  readArchive(id: string): Promise<Record<string, Uint8Array>>;
}
export interface MigrationLogger {
  info(fields: Record<string, unknown>): void;
  warn(fields: Record<string, unknown>): void;
  error(fields: Record<string, unknown>): void;
}
