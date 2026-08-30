import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { RuntimeAdapter, RuntimeExecutionRequest } from "./adapters.js";
import {
  fingerprint,
  runtimeExecutionEvidenceSchema,
  type EvalPack,
  type RuntimeExecutionEvidence,
} from "./contracts.js";

const sourceTurnSchema = z.object({
  status: z.enum(["completed", "failed"]),
  modelId: z.string(),
  skillVersion: z.string().nullable(),
  assistantText: z.string(),
  elapsedMs: z.number(),
  toolCalls: z.array(z.object({
    name: z.string(),
    status: z.enum(["completed", "failed"]),
  })).default([]),
  loadedSkills: z.array(z.object({
    skillId: z.string(),
    version: z.string(),
  })).default([]),
  usage: z.record(z.unknown()).nullable().default(null),
  runtimeIdentityVerified: z.boolean(),
  streamCompleted: z.boolean(),
  error: z.string().nullable(),
}).passthrough();

const sourceReportSchema = z.object({
  sourceType: z.enum(["ea_runtime", "controlled_harness"]).default("ea_runtime"),
  sourceLabel: z.string().optional(),
  cases: z.array(z.object({
    promptId: z.string(),
    left: sourceTurnSchema,
    right: sourceTurnSchema,
  })),
}).passthrough();

function usageNumber(usage: Record<string, unknown> | null, key: string): number | undefined {
  const value = usage?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export class ReplayRuntimeAdapter implements RuntimeAdapter {
  readonly adapterId = "frozen-evidence-replay-v1";
  private readonly cache = new Map<string, z.infer<typeof sourceReportSchema>>();

  constructor(private readonly pack: EvalPack) {}

  private resolveEvidence(relativePath: string): string {
    const baseDir = path.dirname(this.pack.sourceFile);
    const resolved = path.resolve(baseDir, relativePath);
    const relative = path.relative(baseDir, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error(`Replay evidence path escapes Eval Pack: ${relativePath}`);
    }
    return resolved;
  }

  private async load(filePath: string): Promise<z.infer<typeof sourceReportSchema>> {
    const cached = this.cache.get(filePath);
    if (cached) return cached;
    const report = sourceReportSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
    this.cache.set(filePath, report);
    return report;
  }

  async execute(request: RuntimeExecutionRequest): Promise<RuntimeExecutionEvidence> {
    if (!request.evalCase.replay) {
      throw new Error(`Case ${request.evalCase.caseId} has no replay evidence`);
    }
    const evidenceFile = this.resolveEvidence(request.evalCase.replay.evidenceFile);
    const report = await this.load(evidenceFile);
    const sourceCase = report.cases.find(
      item => item.promptId === request.evalCase.replay?.sourcePromptId,
    );
    if (!sourceCase) {
      throw new Error(`Source prompt ${request.evalCase.replay.sourcePromptId} not found`);
    }
    const source = sourceCase[request.side];
    const usage = source.usage;
    return runtimeExecutionEvidenceSchema.parse({
      runId: request.runId,
      side: request.side,
      caseId: request.evalCase.caseId,
      status: source.status,
      modelId: source.modelId,
      skillVersion: source.skillVersion,
      output: source.assistantText,
      elapsedMs: source.elapsedMs,
      toolCalls: source.toolCalls,
      loadedSkills: source.loadedSkills,
      usage: usage ? {
        inputTokens: usageNumber(usage, "input"),
        outputTokens: usageNumber(usage, "output"),
        totalTokens: usageNumber(usage, "total"),
      } : null,
      runtimeIdentityVerified: source.runtimeIdentityVerified,
      streamCompleted: source.streamCompleted,
      error: source.error,
      traceFingerprint: fingerprint(source),
      metadata: {
        sourceType: report.sourceType,
        sourceLabel: report.sourceLabel,
        evidenceFile: path.relative(path.dirname(this.pack.sourceFile), evidenceFile),
      },
    });
  }
}
