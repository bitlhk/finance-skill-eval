import type {
  EvalCase,
  ModelRef,
  RuntimeExecutionEvidence,
  SkillVariant,
} from "./contracts.js";

export type EvaluationSide = "left" | "right";

export type RuntimeExecutionRequest = {
  runId: string;
  side: EvaluationSide;
  evalCase: EvalCase;
  model: ModelRef;
  variant: SkillVariant;
};

export interface RuntimeAdapter {
  readonly adapterId: string;
  prepare?(): Promise<void>;
  execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionEvidence>;
  cleanup?(): Promise<void>;
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
