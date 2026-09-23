import { z } from "zod";
import { fingerprint, modelRefSchema, skillVariantSchema } from "../../contracts.js";
import {runtimeToolConfigSchema} from '../../runtime-tool-config.js';
import {originalServiceSchema} from '../../original-service-runtime.js';

const runtimeSideSchema = z.strictObject({environmentId:z.string().min(1), skillAssetId:z.string().min(1)});

export const serviceEnvironmentReferenceSchema=z.strictObject({migrationId:z.string().regex(/^migration-[a-f0-9-]+$/u),revision:z.number().int().nonnegative(),assetDigest:z.string().regex(/^[a-f0-9]{64}$/u),configurationDigest:z.string().min(1)});
export const runConfigurationSchema = z.strictObject({
  originalService:originalServiceSchema.optional(),
  runtimeHarnessTools:z.array(z.enum(['read_file','glob','list_files','bash'])).max(4).optional(),
  runtimeToolConfig:runtimeToolConfigSchema.optional(),
  runtimeBindings: z.strictObject({left:runtimeSideSchema, right:runtimeSideSchema}).optional(),
  runtimeCommandBindings: z.strictObject({
    left:z.array(z.strictObject({name:z.string().min(1),path:z.string().min(1),kind:z.enum(['PYTHON','NODE']),filePaths:z.array(z.string().min(1)).max(200).default([]),inputSchema:z.unknown().optional(),launch:z.strictObject({program:z.string().min(1),args:z.array(z.string()).max(100)}).optional()})).max(32),
    right:z.array(z.strictObject({name:z.string().min(1),path:z.string().min(1),kind:z.enum(['PYTHON','NODE']),filePaths:z.array(z.string().min(1)).max(200).default([]),inputSchema:z.unknown().optional(),launch:z.strictObject({program:z.string().min(1),args:z.array(z.string()).max(100)}).optional()})).max(32),
  }).optional(),
  runtimeMcpBindings:z.strictObject({
    left:z.array(z.strictObject({assetDigest:z.string().regex(/^[a-f0-9]{64}$/),toolNames:z.array(z.string().min(1)).min(1).max(32),filePaths:z.array(z.string().min(1)).max(200),start:z.array(z.string().min(1)).min(1).max(100),prepare:z.array(z.string().min(1)).max(100).optional(),environmentReference:serviceEnvironmentReferenceSchema.optional()})).max(32),
    right:z.array(z.strictObject({assetDigest:z.string().regex(/^[a-f0-9]{64}$/),toolNames:z.array(z.string().min(1)).min(1).max(32),filePaths:z.array(z.string().min(1)).max(200),start:z.array(z.string().min(1)).min(1).max(100),prepare:z.array(z.string().min(1)).max(100).optional(),environmentReference:serviceEnvironmentReferenceSchema.optional()})).max(32),
  }).optional(),
  packId: z.string().min(1).optional(),
  preparationId: z.string().min(1).optional(),
  runtime: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("replay") }),
    z.strictObject({ type: z.literal("direct_model") }),
    z.strictObject({type:z.literal("runtime_http"),environmentId:z.string().min(1)}),
    z.strictObject({type:z.literal('runtime_launcher'),environmentId:z.string().min(1)}),
  ]),
  judgeMode: z.enum(["deterministic", "model"]).default("deterministic"),
  evaluationMode: z.enum(["pairwise", "candidate_assessment", "service_comparison"]).default("pairwise"),
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
  if((value.evaluationMode==='service_comparison')!==Boolean(value.originalService))context.addIssue({code:z.ZodIssueCode.custom,message:'原服务对比模式必须配置原服务，其他模式不能附带原服务配置'});
  const managedRuntime=value.runtime.type==='runtime_http'||value.runtime.type==='runtime_launcher';
  if(value.runtime.type==='runtime_launcher'&&!value.runtimeBindings)context.addIssue({code:z.ZodIssueCode.custom,message:'Runtime Launcher requires explicit left and right Runtime bindings.'});
  if(value.evaluationMode==='service_comparison'&&(!value.runtimeBindings||!managedRuntime||value.judgeMode!=='model'||value.caseSource!=='fixed'||!value.preparationId||value.includeHoldout))context.addIssue({code:z.ZodIssueCode.custom,message:'原服务对比需要固定测试集、模型评估和显式候选 Runtime 绑定'});
  if(value.runtimeToolConfig && !managedRuntime)context.addIssue({code:z.ZodIssueCode.custom,message:'Runtime context requires a managed Runtime environment'});
  if (value.runtimeBindings && (value.runtime.type!=='runtime_launcher' || value.caseSource !== 'fixed'
      || !value.leftVariant || !value.rightVariant || value.leftVariant.mode !== 'skill_version' || value.rightVariant.mode !== 'skill_version'
      || !value.executionModel || (value.leftExecutionModel && fingerprint(value.leftExecutionModel) !== fingerprint(value.executionModel))
      || (value.rightExecutionModel && fingerprint(value.rightExecutionModel) !== fingerprint(value.executionModel)))) {
    context.addIssue({code:z.ZodIssueCode.custom,message:'Paired migration requires a Runtime Launcher, explicit Skill versions, fixed cases and the same execution model.'});
  }
  if (value.caseSource === "ai_generated" && (value.runtime.type === "replay" || value.preparationId || value.includeHoldout || value.selectedCaseIds.length || value.judgeMode !== "model")) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "动态出题需要在线执行与模型 Judge，不能混用回放、已准备题集、固定题选择或留出集。" });
  }
  if (Boolean(value.packId) === Boolean(value.preparationId)) context.addIssue({code:z.ZodIssueCode.custom,message:"Exactly one of packId or preparationId is required"});
});

export type RunConfiguration = z.infer<typeof runConfigurationSchema>;
