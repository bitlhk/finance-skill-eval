import { z } from "zod";
import { evalCaseSchema, modelRefSchema, skillVariantSchema } from "../contracts.js";

export const environmentRecordSchema = z.strictObject({
  environmentId: z.string().min(1),
  name: z.string().min(1),
  type: z.enum(["mcp_streamable_http", "runtime_http"]),
  endpoint: z.string().url(),
  credentialEnv: z.string().min(1).nullable().default(null),
  mcpEnvironmentIds: z.array(z.string().min(1)).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const createEnvironmentSchema = z.strictObject({
  name: z.string().min(1).max(80),
  type: z.enum(["mcp_streamable_http", "runtime_http"]),
  endpoint: z.string().url(),
  credentialEnv: z.string().min(1).max(100).nullable().optional(),
  mcpEnvironmentIds: z.array(z.string().min(1)).max(12).default([]),
});

export const runConfigurationSchema = z.strictObject({
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
  skillAssetId: z.string().min(1).optional(),
  selectedCaseIds: z.array(z.string().min(1)).max(8).default([]),
  leftVariant: skillVariantSchema.optional(),
  rightVariant: skillVariantSchema.optional(),
  executionModel: modelRefSchema.optional(),
  judgeModel: modelRefSchema.optional(),
  timeoutMs: z.number().int().min(10_000).max(900_000).default(310_000),
}).superRefine((value, context) => {
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
});

export type EnvironmentRecord = z.infer<typeof environmentRecordSchema>;
export type RunConfiguration = z.infer<typeof runConfigurationSchema>;
