import { z } from "zod";
import type { RuntimeAdapter, RuntimeExecutionRequest } from "./adapters.js";
import {
  fingerprint,
  runtimeExecutionEvidenceSchema,
  type RuntimeExecutionEvidence,
} from "./contracts.js";
import type { ResolvedSkillSource } from "./direct-model-runtime.js";
import type {RuntimeToolConfig} from './runtime-tool-config.js';

export type RuntimeEnvironmentDescriptor = {
  runtimeToolConfig?:RuntimeToolConfig;
  environmentId: string;
  requiredToolNames?: string[];
  availableToolNames?:string[];
  harnessToolNames?:Array<'read_file'|'glob'|'list_files'|'bash'>;
  mcpServers?: Array<{
    serverId: string;
    endpoint: string;
    transport: "streamable_http";
    toolNames: string[];
    credentialEnv?: string | null;
  }>;
  commandScripts?:Array<{name:string;path:string;kind:'PYTHON'|'NODE';filePaths:string[];inputSchema?:unknown;launch?:{program:string;args:string[]}}>;
  /** The worker starts these inside the candidate workspace, never a same-name external service. */
  candidateMcpServices?:Array<{assetDigest:string;toolNames:string[];filePaths:string[];start:string[];prepare?:string[];environment?:Record<string,string>;secretEnvironment?:Record<string,string>;secretBindings?:Record<string,string>}>;
};

export type HttpRuntimeAdapterOptions = {
  adapterId: string;
  endpoint: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  requireLoadedDigest?: boolean;
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
        case: { caseId: request.evalCase.caseId, prompt: request.evalCase.prompt,
          taskMode: request.evalCase.taskMode, requiredTools: request.evalCase.requiredTools },
        model: request.model,
        variant: request.variant,
        skill,
        environment: this.options.environment ?? null,
      }),
    });
    if (!response.ok) {
      const raw = await response.text();
      throw new Error(`Runtime execution failed with HTTP ${response.status}: ${raw.slice(0, 600)}`);
    }
    let value: unknown;
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      if (!response.body) throw new Error("Runtime stream is empty");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        while (true) {
          const chunk = await reader.read();
          buffer = (buffer + decoder.decode(chunk.value, { stream: !chunk.done })).replaceAll("\r\n", "\n");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (!data) continue;
            const event = JSON.parse(data);
            if (event.evidence) value = event.evidence;
            else if (["status", "text_delta", "tool_start", "tool_end"].includes(event.type)) {
              request.onEvent?.({ ...event, caseId: request.evalCase.caseId, side: request.side });
            }
          }
          if (chunk.done) break;
        }
      } finally { await reader.cancel().catch(() => undefined); }
      if (!value) throw new Error("Runtime stream ended without execution evidence");
    } else value = await response.json();
    const parsed = wrappedResponseSchema.parse(value);
    const evidence = "evidence" in parsed ? parsed.evidence : parsed;
    if (evidence.caseId !== request.evalCase.caseId || evidence.side !== request.side) {
      throw new Error("Runtime evidence does not match the requested case and side");
    }
    if (evidence.modelId !== request.model.modelId) throw new Error("Runtime used a different model than requested");
    if (evidence.status === 'failed' && !evidence.runtimeIdentityVerified) {
      throw new Error(evidence.error ?? 'Runtime stopped before producing verified execution evidence');
    }
    if (this.options.requireLoadedDigest && (!skill || !evidence.metadata.skillArtifactSha256)) {
      throw new Error('Migration requires an observed loaded Skill digest');
    }
    if (skill && evidence.metadata.skillArtifactSha256 && evidence.metadata.skillArtifactSha256 !== skill.artifactSha256) throw new Error("Runtime loaded a different Skill digest");
    if (skill && !evidence.loadedSkills.some(item => item.skillId === skill.skillId && item.version === skill.version)) {
      throw new Error("Runtime did not load the requested Skill artifact");
    }
    if (request.variant.mode === "without_target_skill" && evidence.loadedSkills.some(item => item.skillId === request.variant.skillId)) {
      throw new Error("Baseline unexpectedly loaded the target Skill");
    }
    return {
      ...evidence,
      runId: request.runId,
      traceFingerprint: evidence.traceFingerprint ?? fingerprint(evidence),
      metadata: {
        ...evidence.metadata,
        executionMode: "http",
        runtimeEndpoint: new URL(this.options.endpoint).origin,
      },
    };
  }
}
