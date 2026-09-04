import { z } from "zod";
import type { RuntimeAdapter, RuntimeExecutionRequest } from "./adapters.js";
import {
  fingerprint,
  runtimeExecutionEvidenceSchema,
  type RuntimeExecutionEvidence,
} from "./contracts.js";
import type { ResolvedSkillSource } from "./direct-model-runtime.js";

export type RuntimeEnvironmentDescriptor = {
  environmentId: string;
  mcpServers?: Array<{
    serverId: string;
    endpoint: string;
    transport: "streamable_http";
    toolNames: string[];
  }>;
};

export type HttpRuntimeAdapterOptions = {
  adapterId: string;
  endpoint: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  environment?: RuntimeEnvironmentDescriptor;
  resolveSkill?(variant: RuntimeExecutionRequest["variant"]): Promise<ResolvedSkillSource | null>;
};

const wrappedResponseSchema = z.union([
  runtimeExecutionEvidenceSchema,
  z.strictObject({ evidence: runtimeExecutionEvidenceSchema }),
]);

/** Calls an Agent Runtime over the Finance Skill Eval canonical HTTP contract. */
export class HttpRuntimeAdapter implements RuntimeAdapter {
  readonly adapterId: string;

  constructor(private readonly options: HttpRuntimeAdapterOptions) {
    this.adapterId = options.adapterId;
  }

  async prepare(): Promise<void> {
    const healthUrl = new URL(this.options.endpoint);
    healthUrl.pathname = healthUrl.pathname.replace(/\/execute\/?$/, "/health");
    const response = await fetch(healthUrl, {
      headers: this.options.headers,
      signal: AbortSignal.timeout(Math.min(this.options.timeoutMs ?? 310_000, 10_000)),
    });
    if (!response.ok) {
      throw new Error(`Runtime preflight failed with HTTP ${response.status}`);
    }
  }

  async execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionEvidence> {
    const skill = await this.options.resolveSkill?.(request.variant) ?? null;
    if (request.variant.mode === "skill_version" && this.options.resolveSkill && !skill) {
      throw new Error(`Skill artifact is unavailable: ${request.variant.skillId}@${request.variant.version}`);
    }
    const response = await fetch(this.options.endpoint, {
      method: "POST",
      signal: request.signal
        ? AbortSignal.any([
          request.signal,
          AbortSignal.timeout(this.options.timeoutMs ?? 310_000),
        ])
        : AbortSignal.timeout(this.options.timeoutMs ?? 310_000),
      headers: {
        "content-type": "application/json",
        ...this.options.headers,
      },
      body: JSON.stringify({
        schemaVersion: "finance.skill-eval.runtime-request.v1",
        runId: request.runId,
        side: request.side,
        case: request.evalCase,
        model: request.model,
        variant: request.variant,
        skill,
        environment: this.options.environment ?? null,
      }),
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Runtime execution failed with HTTP ${response.status}: ${raw.slice(0, 600)}`);
    }
    const parsed = wrappedResponseSchema.parse(JSON.parse(raw));
    const evidence = "evidence" in parsed ? parsed.evidence : parsed;
    if (evidence.caseId !== request.evalCase.caseId || evidence.side !== request.side) {
      throw new Error("Runtime evidence does not match the requested case and side");
    }
    return {
      ...evidence,
      runId: request.runId,
      skillVersion: request.variant.mode === "skill_version" ? request.variant.version : null,
      traceFingerprint: evidence.traceFingerprint ?? fingerprint(evidence),
      metadata: {
        ...evidence.metadata,
        executionMode: "http",
        runtimeEndpoint: new URL(this.options.endpoint).origin,
      },
    };
  }
}
