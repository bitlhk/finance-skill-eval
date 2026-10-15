import { createHash } from "node:crypto";
import { z } from "zod";

const strictRecordValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
]);

const modelParametersSchema = z.record(z.union([
  strictRecordValueSchema, z.strictObject({type:z.literal('disabled')}),
])).superRefine((parameters, context) => {
  for (const [key,value] of Object.entries(parameters)) {
    if (value !== null && typeof value === 'object' && key !== 'thinking')
      context.addIssue({code:z.ZodIssueCode.custom,path:[key],message:'Only the closed thinking mode supports an object value.'});
  }
});

export const modelRefSchema = z.strictObject({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  label: z.string().min(1).optional(),
  credentialRef: z.string().min(1).optional(),
  parameters: modelParametersSchema.default({}),
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

export const workspaceFileSchema = z.strictObject({
  path: z.string().trim().min(1).max(240).refine(value => {
    if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
    return value.split("/").every(part => part.length > 0 && part !== "." && part !== "..");
  }, "工作区文件路径必须是安全的 POSIX 相对路径"),
  content: z.string().max(256 * 1024).refine(value => !value.includes("\0"), "案例文件只支持不含 NUL 的文本"),
});

export const workspaceFilesSchema = z.array(workspaceFileSchema).max(32).superRefine((files, context) => {
  const paths = new Set<string>();
  let bytes = 0;
  files.forEach((file, index) => {
    if (paths.has(file.path)) context.addIssue({ code: z.ZodIssueCode.custom, path: [index, "path"], message: "工作区文件路径不能重复" });
    paths.add(file.path);
    bytes += new TextEncoder().encode(file.content).byteLength;
  });
  if (bytes > 1024 * 1024) context.addIssue({ code: z.ZodIssueCode.custom, message: "单条测试用例的工作区文件总大小不能超过 1 MB" });
});

export const conversationTurnsSchema=z.array(z.strictObject({
  query:z.string().trim().min(1).max(4000),
  requiredTools:z.array(z.string().min(1)).max(32).default([]),
})).min(2).max(8);

export const evalCaseSchema = z.strictObject({
  caseId: z.string().min(1),
  name: z.string().min(1),
  taskMode: z.enum(["single_turn", "multi_turn"]).default("single_turn"),
  prompt: z.string().min(1),
  evaluationGoal: z.string().min(1),
  requiredTools: z.array(z.string().min(1)).default([]),
  /** Business fixtures mounted into an isolated workspace for this case only. */
  workspaceFiles: workspaceFilesSchema.optional(),
  /** Executed as distinct native Agent turns in one isolated case, never simulated in a prompt. */
  turns:conversationTurnsSchema.optional(),
  /** Availability and invocation are different: stop-early cases may forbid later tools. */
  toolExpectations:z.strictObject({mustSucceed:z.array(z.string().min(1)),mustNotCall:z.array(z.string().min(1)).default([])}).optional(),
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
  holdoutCaseFiles: z.array(z.string().min(1)).max(8).optional(),
  metadata: z.record(z.string()).default({}),
});

export const evaluationUsageSchema = z.strictObject({
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative().optional(),
});

export const toolCallEvidenceSchema = z.strictObject({
  name: z.string().min(1).max(200),
  status: z.enum(["completed", "failed"]),
});

export const RUNTIME_EXECUTION_EVIDENCE_LIMITS={serializedBytes:262_144,outputCharacters:131_072,errorCharacters:8_192,toolCalls:1_024,loadedSkills:256} as const;
export const runtimeExecutionEvidenceSchema = z.strictObject({
  runId: z.string().min(1).max(200),
  side: z.enum(["left", "right"]),
  caseId: z.string().min(1).max(200),
  status: z.enum(["completed", "failed"]),
  modelId: z.string().min(1).max(200),
  skillVersion: z.string().max(200).nullable(),
  output: z.string().max(RUNTIME_EXECUTION_EVIDENCE_LIMITS.outputCharacters),
  elapsedMs: z.number().nonnegative(),
  toolCalls: z.array(toolCallEvidenceSchema).max(RUNTIME_EXECUTION_EVIDENCE_LIMITS.toolCalls).default([]),
  loadedSkills: z.array(z.strictObject({
    skillId: z.string().min(1).max(200),
    version: z.string().min(1).max(200),
  })).max(RUNTIME_EXECUTION_EVIDENCE_LIMITS.loadedSkills).default([]),
  usage: evaluationUsageSchema.nullable().default(null),
  runtimeIdentityVerified: z.boolean(),
  streamCompleted: z.boolean(),
  error: z.string().max(RUNTIME_EXECUTION_EVIDENCE_LIMITS.errorCharacters).nullable(),
  traceFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  metadata: z.record(z.unknown()).default({}),
}).superRefine((value,context)=>{
  let serialized:string;
  try{serialized=JSON.stringify(value);}catch{context.addIssue({code:'custom',message:'Runtime execution evidence must be JSON serializable'});return;}
  if(new TextEncoder().encode(serialized).byteLength>RUNTIME_EXECUTION_EVIDENCE_LIMITS.serializedBytes){
    context.addIssue({code:'custom',message:`Runtime execution evidence exceeds ${RUNTIME_EXECUTION_EVIDENCE_LIMITS.serializedBytes} serialized bytes`});
  }
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

export const goalAssessmentSchema=z.strictObject({verdict:z.enum(['PASS','FAIL','INDETERMINATE']),reason:z.string().min(1),checks:z.array(z.strictObject({criterion:z.string().min(1),verdict:z.enum(['PASS','FAIL','INDETERMINATE']),reason:z.string().min(1),evidence:z.string()})).min(1)});
export const judgeResultSchema = z.strictObject({
  runtimeComparison:z.strictObject({
    left:z.discriminatedUnion('status',[
      z.strictObject({status:z.literal('assessed'),assessment:goalAssessmentSchema}),
      z.strictObject({status:z.literal('unavailable'),error:z.string().min(1)}),
    ]),
    right:z.discriminatedUnion('status',[
      z.strictObject({status:z.literal('assessed'),assessment:goalAssessmentSchema}),
      z.strictObject({status:z.literal('unavailable'),error:z.string().min(1)}),
    ]),
  }).optional(),
  serviceComparison:z.strictObject({verdict:z.enum(['PASS','FAIL','INDETERMINATE']),reason:z.string().min(1),checks:z.array(z.strictObject({criterion:z.string().min(1),verdict:z.enum(['PASS','FAIL','INDETERMINATE']),reason:z.string().min(1),originalEvidence:z.string(),candidateEvidence:z.string()})).min(1)}).optional(),
  goalAssessment:goalAssessmentSchema.optional(),
  winner: z.enum(["left", "right", "tie"]).optional(),
  confidence: z.enum(["low", "medium", "high"]),
  summary: z.string().min(1),
  dimensions: z.array(judgeDimensionResultSchema).max(4),
  reviewerLabel: z.string().min(1),
}).refine(result=>result.goalAssessment||result.serviceComparison||result.runtimeComparison?result.dimensions.length===0:result.dimensions.length===4,{message:'目标评估和服务对比不使用维度分数；常规评估必须包含四个维度'})
  .refine(result=>[result.goalAssessment,result.serviceComparison,result.runtimeComparison].filter(Boolean).length<=1,{message:'评估结果模式不能同时出现'})
  .refine(result=>result.runtimeComparison?result.winner===undefined:result.winner!==undefined,{message:'只有同候选跨 Runtime 评估不使用胜方'});

export const evaluationScenarioSeedSchema = z.strictObject({
  seedId: z.string().min(1),
  title: z.string().min(1),
  scenarioType: z.string().min(1),
  subject: z.strictObject({
    ref: z.string().min(1),
    label: z.string().min(1),
  }).optional(),
  promptFacts: z.array(z.string().min(1)).max(12).default([]),
  verificationFacts: z.array(z.string().min(1)).max(20).default([]),
  missingFacts: z.array(z.string().min(1)).max(12).default([]),
  tags: z.array(z.string().min(1)).max(12).default([]),
});

export const evaluationContextPayloadSchema = z.strictObject({
  sourceLabel: z.string().min(1),
  mode: z.enum(["host_enhanced", "static_fixture"]),
  asOf: z.string().datetime().optional(),
  capabilities: z.array(z.string().min(1)).max(30).default([]),
  seeds: z.array(evaluationScenarioSeedSchema).min(1).max(20),
  redaction: z.literal("sanitized"),
  metadata: z.record(strictRecordValueSchema).default({}),
});

export const evaluationContextSnapshotSchema = evaluationContextPayloadSchema.extend({
  schemaVersion: z.literal("finance.skill-eval.context-snapshot.v1"),
  providerId: z.string().min(1),
  snapshotFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
});

export type ModelRef = z.infer<typeof modelRefSchema>;
export type SkillVariant = z.infer<typeof skillVariantSchema>;
export type RubricCriterion = z.infer<typeof rubricCriterionSchema>;
export type EvalCase = z.infer<typeof evalCaseSchema>;
export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;
export type JudgeProfile = z.infer<typeof judgeProfileSchema>;
export type EvalPackFile = z.infer<typeof evalPackFileSchema>;
export type RuntimeExecutionEvidence = z.infer<typeof runtimeExecutionEvidenceSchema>;
export type JudgeResult = z.infer<typeof judgeResultSchema>;
export type EvaluationScenarioSeed = z.infer<typeof evaluationScenarioSeedSchema>;
export type EvaluationContextPayload = z.infer<typeof evaluationContextPayloadSchema>;
export type EvaluationContextSnapshot = z.infer<typeof evaluationContextSnapshotSchema>;

export type EvalPack = Omit<EvalPackFile, "caseFiles" | "judgeProfileFile"> & {
  holdoutCases?: EvalCase[];
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

export function workspaceFilesDigest(files: readonly WorkspaceFile[]): string {
  workspaceFilesSchema.parse(files);
  const hash = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)) {
    hash.update(file.path, "utf8").update("\0").update(file.content, "utf8").update("\0");
  }
  return hash.digest("hex");
}

export type FrozenQuestionSet = {
  source: "ai_generated";
  summary: string;
  cases: EvalCase[];
  fingerprint: string;
  generatedAt: string;
  generationId: string;
  model: ModelRef;
  skillArtifactSha256: string;
  sourceFiles: string[];
};
