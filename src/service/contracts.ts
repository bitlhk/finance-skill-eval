import { z } from "zod";
import { evalCaseSchema, fingerprint, modelRefSchema, skillVariantSchema } from "../contracts.js";

const runtimeSideSchema = z.strictObject({environmentId:z.string().min(1), skillAssetId:z.string().min(1)});

export const environmentRecordSchema = z.strictObject({
  environmentId: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["mcp_streamable_http", "runtime_http"]),
  runtimeType: z.enum(["openjiuwen", "ea", "generic_http"]).nullable().default(null),
  endpoint: z.string().url(),
  credentialEnv: z.string().min(1).nullable().default(null),
  mcpEnvironmentIds: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const createEnvironmentSchema = z.strictObject({
  name: z.string().min(1).max(80),
  type: z.enum(["mcp_streamable_http", "runtime_http"]),
  runtimeType: z.enum(["openjiuwen", "ea", "generic_http"]).nullable().optional(),
  endpoint: z.string().url(),
  credentialEnv: z.string().min(1).max(100).nullable().optional(),
  mcpEnvironmentIds: z.array(z.string().min(1)).max(12).default([]),
});

export const runConfigurationSchema = z.strictObject({
  runtimeBindings: z.strictObject({left:runtimeSideSchema, right:runtimeSideSchema}).optional(),
  runtimeToolBindings: z.strictObject({
    left:z.array(z.strictObject({name:z.string().min(1),path:z.string().min(1),kind:z.enum(['PYTHON','NODE']),filePaths:z.array(z.string().min(1)).max(200).default([]),inputSchema:z.unknown().optional()})).max(32),
    right:z.array(z.strictObject({name:z.string().min(1),path:z.string().min(1),kind:z.enum(['PYTHON','NODE']),filePaths:z.array(z.string().min(1)).max(200).default([]),inputSchema:z.unknown().optional()})).max(32),
  }).optional(),
  packId: z.string().min(1).optional(),
  preparationId: z.string().min(1).optional(),
  runtime: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("replay") }),
    z.strictObject({ type: z.literal("direct_model") }),
    z.strictObject({
      type: z.literal("runtime_http"),
      environmentId: z.string().min(1),
    }),
  ]),
  judgeMode: z.enum(["deterministic", "model"]).default("deterministic"),
  evaluationMode: z.enum(["pairwise", "candidate_assessment"]).default("pairwise"),
  skillAssetId: z.string().min(1).optional(),
  caseSource: z.enum(["fixed", "ai_generated"]).default("fixed"),
  generatedCaseCount: z.number().int().min(1).max(3).default(3),
  selectedCaseIds: z.array(z.string().min(1)).max(8).default([]),
  includeHoldout: z.boolean().default(false),
  leftVariant: skillVariantSchema.optional(),
  rightVariant: skillVariantSchema.optional(),
  executionModel: modelRefSchema.optional(),
  leftExecutionModel: modelRefSchema.optional(),
  rightExecutionModel: modelRefSchema.optional(),
  judgeModel: modelRefSchema.optional(),
  timeoutMs: z.number().int().min(10_000).max(900_000).default(310_000),
}).superRefine((value, context) => {
  if (value.runtimeBindings && (value.runtime.type !== 'runtime_http' || value.caseSource !== 'fixed'
      || !value.leftVariant || !value.rightVariant || value.leftVariant.mode !== 'skill_version' || value.rightVariant.mode !== 'skill_version'
      || !value.executionModel || (value.leftExecutionModel && fingerprint(value.leftExecutionModel) !== fingerprint(value.executionModel))
      || (value.rightExecutionModel && fingerprint(value.rightExecutionModel) !== fingerprint(value.executionModel)))) {
    context.addIssue({code:z.ZodIssueCode.custom,message:'Paired migration requires HTTP runtimes, explicit Skill versions, fixed cases and the same execution model.'});
  }
  if (value.caseSource === "ai_generated" && (value.runtime.type === "replay" || value.preparationId || value.includeHoldout || value.selectedCaseIds.length || value.judgeMode !== "model")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "动态出题需要在线执行与模型 Judge，不能混用回放、已准备题集、固定题选择或留出集。" });
  }
  if (Boolean(value.packId) === Boolean(value.preparationId)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Exactly one of packId or preparationId is required",
    });
  }
});

export const prepareSkillSchema = z.strictObject({
  domainContext: z.string().max(8_000).optional(),
  role: z.string().max(120).optional(),
  maximumCases: z.number().int().min(1).max(8).default(4),
  model: modelRefSchema.optional(),
});

export const manualPreparationSchema = z.strictObject({
  summary: z.string().min(1).max(2_000),
  cases: z.array(evalCaseSchema.omit({ replay: true })).min(1).max(8),
  holdoutCases: z.array(evalCaseSchema.omit({ replay: true })).max(8).default([]),
}).superRefine((value,context)=>{
  const ids=[...value.cases,...value.holdoutCases].map(c=>c.caseId);
  if (new Set(ids).size!==ids.length) context.addIssue({code:z.ZodIssueCode.custom,message:'Development and holdout case IDs must be disjoint and unique'});
});

export type EnvironmentRecord = z.infer<typeof environmentRecordSchema>;
export type RunConfiguration = z.infer<typeof runConfigurationSchema>;
