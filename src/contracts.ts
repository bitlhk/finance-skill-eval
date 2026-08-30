import { createHash } from "node:crypto";
import { z } from "zod";

const strictRecordValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

export const modelRefSchema = z.strictObject({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  label: z.string().min(1).optional(),
  credentialRef: z.string().min(1).optional(),
  parameters: z.record(strictRecordValueSchema).default({}),
});

export const skillVariantSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("without_target_skill"),
    skillId: z.string().min(1),
  }),
  z.strictObject({
    mode: z.literal("skill_version"),
    skillId: z.string().min(1),
    version: z.string().min(1),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  }),
]);

export const rubricCriterionSchema = z.strictObject({
  criterionId: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  dimension: z.enum([
    "professional_fit",
    "business_completeness",
    "clarity",
    "actionability",
  ]),
  weight: z.number().positive(),
  required: z.boolean().default(false),
  allOf: z.array(z.string().min(1)).default([]),
  anyOf: z.array(z.string().min(1)).default([]),
  noneOf: z.array(z.string().min(1)).default([]),
  improvementHint: z.string().min(1).optional(),
});

export const evalCaseSchema = z.strictObject({
  caseId: z.string().min(1),
  name: z.string().min(1),
  taskMode: z.enum(["single_turn", "multi_turn"]).default("single_turn"),
  prompt: z.string().min(1),
  evaluationGoal: z.string().min(1),
  requiredTools: z.array(z.string().min(1)).default([]),
  rubric: z.array(rubricCriterionSchema).min(1),
  replay: z.strictObject({
    evidenceFile: z.string().min(1),
    sourcePromptId: z.string().min(1),
  }).optional(),
});

export const judgeProfileSchema = z.strictObject({
  schemaVersion: z.literal("finance.skill-eval.judge-profile.v1"),
  profileId: z.string().min(1),
  version: z.string().min(1),
  reviewerLabel: z.string().min(1),
  domainInstructions: z.string().min(1),
  dimensions: z.array(z.strictObject({
    id: z.enum([
      "professional_fit",
      "business_completeness",
      "clarity",
      "actionability",
    ]),
    label: z.string().min(1),
    description: z.string().min(1),
  })).length(4),
});

export const evalPackFileSchema = z.strictObject({
  schemaVersion: z.literal("finance.skill-eval.pack.v1"),
  packId: z.string().min(1),
  version: z.string().min(1),
  domain: z.string().min(1),
  targetSkillId: z.string().min(1),
  targetSkillVersion: z.string().min(1),
  description: z.string().min(1),
  models: z.strictObject({
    analyzer: modelRefSchema,
    execution: z.strictObject({
      left: modelRefSchema,
      right: modelRefSchema,
    }),
    judge: modelRefSchema,
  }),
  variants: z.strictObject({
    left: skillVariantSchema,
    right: skillVariantSchema,
  }),
  judgeProfileFile: z.string().min(1),
  caseFiles: z.array(z.string().min(1)).min(1),
  metadata: z.record(z.string()).default({}),
});

export const evaluationUsageSchema = z.strictObject({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
});

export const toolCallEvidenceSchema = z.strictObject({
  name: z.string().min(1),
  status: z.enum(["completed", "failed"]),
});

export const runtimeExecutionEvidenceSchema = z.strictObject({
  runId: z.string().min(1),
  side: z.enum(["left", "right"]),
  caseId: z.string().min(1),
  status: z.enum(["completed", "failed"]),
  modelId: z.string().min(1),
  skillVersion: z.string().nullable(),
  output: z.string(),
  elapsedMs: z.number().nonnegative(),
  toolCalls: z.array(toolCallEvidenceSchema).default([]),
  loadedSkills: z.array(z.strictObject({
    skillId: z.string().min(1),
    version: z.string().min(1),
  })).default([]),
  usage: evaluationUsageSchema.nullable().default(null),
  runtimeIdentityVerified: z.boolean(),
  streamCompleted: z.boolean(),
  error: z.string().nullable(),
  traceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const judgeDimensionResultSchema = z.strictObject({
  id: z.enum([
    "professional_fit",
    "business_completeness",
    "clarity",
    "actionability",
  ]),
  label: z.string().min(1),
  leftScore: z.number().min(0).max(4),
  rightScore: z.number().min(0).max(4),
  reason: z.string().min(1),
});

export const judgeResultSchema = z.strictObject({
  winner: z.enum(["left", "right", "tie"]),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string().min(1),
  dimensions: z.array(judgeDimensionResultSchema).length(4),
  reviewerLabel: z.string().min(1),
});

export type ModelRef = z.infer<typeof modelRefSchema>;
export type SkillVariant = z.infer<typeof skillVariantSchema>;
export type RubricCriterion = z.infer<typeof rubricCriterionSchema>;
export type EvalCase = z.infer<typeof evalCaseSchema>;
export type JudgeProfile = z.infer<typeof judgeProfileSchema>;
export type EvalPackFile = z.infer<typeof evalPackFileSchema>;
export type RuntimeExecutionEvidence = z.infer<typeof runtimeExecutionEvidenceSchema>;
export type JudgeResult = z.infer<typeof judgeResultSchema>;

export type EvalPack = Omit<EvalPackFile, "caseFiles" | "judgeProfileFile"> & {
  sourceFile: string;
  cases: EvalCase[];
  judgeProfile: JudgeProfile;
  packFingerprint: string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
