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
import type { RuntimeBuildResult } from '../../../shared/contracts/runtime-builder.js';
import type { RuntimeLauncherBinding } from '../../../shared/contracts/environment.js';
export interface TaskBuilderPort {
  accept(input: { request: TaskBuildRequest; configuration?: BundleConfiguration; result: RuntimeBuildResult; trustReference: string; name?: string;
    snapshot: BundleSnapshot; services: BundleDelivery['services'] }): Promise<{
      configuration: BundleConfiguration; environmentSnapshot: unknown; launcher: RuntimeLauncherBinding;
    }>;
}
export type MigrationCorrelation = { taskId: string; attemptId: string; requestId?: string; agentRunId: string; };
export type BundleAgentInput = {
  /** Optimization grants a combined engineering adjustment, without creating separate editors. */
  adjustmentCapabilities?:Array<'document'|'tool'|'runtime'>;
  roleVersion?: string;
  onComposition?: (receipt: import('../../../shared/contracts/agent-composition.js').AgentCompositionReceipt) => Promise<void> | void;
  correlation?: MigrationCorrelation;
  mode: 'PREPARE' | 'ANALYZE' | 'GENERATE' | 'REPAIR';
  project?: { notes: string; preparation?: import('../domain/project-preparation.js').ProjectPreparation };
  source: BundleSnapshot;
  base: BundleSnapshot;
  goal: string;
  target: string;
  analysis?: BundleAnalysis;
  clarification?: string;
  feedback?: unknown;
  signal: AbortSignal;
};
export type BundleAgentResult = {
  status: 'PRODUCED' | 'ABSTAINED';
  reason?: string;
  analysis?: BundleAnalysis;
  delivery?: BundleDelivery;
  files?: Record<string, string>;
  preparation?: import('../domain/project-preparation.js').ProjectPreparation;
  executions?: import('../domain/project-preparation.js').ProjectExecutionReceipt[];
};
export type BundleAgent = (input: BundleAgentInput) => Promise<BundleAgentResult>;
export type BundleExecution = { runtime: RuntimeAdapter; model: ModelRef; environmentSnapshot: unknown; };
export type BundleRuntimeFactory = (input: {
  executionMode?: 'agent_project';
  snapshot: BundleSnapshot;
  services: BundleDelivery['services'];
  configuration: BundleConfiguration;
  signal: AbortSignal;
}) => Promise<BundleExecution>;
export type BundleJudge = ((input: {
  onComposition?:(receipt:import('../../../shared/contracts/agent-composition.js').AgentCompositionReceipt)=>Promise<void>|void;
  correlation?: { taskId: string; attemptId: string; runId: string; requestId?: string; };
  evalCase: EvalCase;
  evidence: RuntimeExecutionEvidence;
  requirements?:import('../domain/task-standardization.js').Standardization['requirements'];
  tools?:BundleDelivery['tools'];
  signal: AbortSignal;
}) => Promise<BundleVerdict>) & { identity?: () => string; timeoutMs?: () => number };

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
