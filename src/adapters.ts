import type {
  EvalCase,
  EvaluationContextPayload,
  ModelRef,
  RuntimeExecutionEvidence,
  SkillVariant,
} from "./contracts.js";

export type EvaluationSide = "left" | "right";

export type EvaluationContextRequest = {
  skillId: string;
  domain?: string;
  role?: string;
  maximumSeeds: number;
};

export interface EvaluationContextAdapter {
  readonly adapterId: string;
  load(request: EvaluationContextRequest): Promise<EvaluationContextPayload | null>;
}

export type RuntimeExecutionRequest = {
  onEvent?: (event: RuntimeEvent) => void;
  runId: string;
  side: EvaluationSide;
  evalCase: EvalCase;
  model: ModelRef;
  variant: SkillVariant;
  signal?: AbortSignal;
};

export type RuntimeEvent = {
  type: "status" | "text_delta" | "tool_start" | "tool_end";
  caseId: string;
  side: EvaluationSide;
  text?: string;
  toolName?: string;
  status?: string;
};

export type RuntimePrepareContext={runId:string;signal?:AbortSignal};

export class RuntimeExecutionFailure extends Error {
  constructor(message: string, readonly metadata: Record<string, unknown>) {
    super(message);
    this.name = 'RuntimeExecutionFailure';
  }
}

export class RuntimeCaseNotExecutedError extends Error {
  constructor(readonly failedCaseId: string) {
    super(`本题未执行：该端在案例 ${failedCaseId} 后执行状态不再可信，已停止后续案例；请查看首个失败。`);
    this.name = 'RuntimeCaseNotExecutedError';
  }
}

export interface RuntimeAdapter {
  readonly adapterId: string;
  prepare?(context:RuntimePrepareContext): Promise<void>;
  execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionEvidence>;
  cleanup?(): Promise<void>;
  finalizationEvidence?(): Record<string, unknown>;
}

export type ModelMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ModelCompletionRequest = {
  requestId: string;
  model: ModelRef;
  messages: ModelMessage[];
  responseFormat?: "text" | "json";
  signal?: AbortSignal;
};

export type ModelCompletionResponse = {
  content: string;
  modelId: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  metadata?: Record<string, unknown>;
};

export interface ModelAdapter {
  readonly adapterId: string;
  complete(request: ModelCompletionRequest): Promise<ModelCompletionResponse>;
}

export type MetricEvaluation = {
  metricId: string;
  score: number;
  reason: string;
};

export interface MetricAdapter {
  readonly adapterId: string;
  evaluate(input: {
    evalCase: EvalCase;
    evidence: RuntimeExecutionEvidence;
  }): Promise<MetricEvaluation[]>;
}
