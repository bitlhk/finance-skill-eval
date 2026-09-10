import { readFile } from "node:fs/promises";
import { z } from "zod";
import { modelRefSchema, type ModelRef } from "../contracts.js";
import { configuredModelRole } from "./config.js";

const optionSchema = modelRefSchema.extend({
  providerLabel: z.string().optional(),
  availability: z.enum(["ready", "unverified", "unavailable"]).default("unverified"),
  statusNote: z.string().optional(),
});
const catalogSchema = z.object({
  schemaVersion: z.literal("finance.skill-eval.execution-models.v1"),
  defaultModelId: z.string().min(1),
  models: z.array(optionSchema).min(1),
});
export type ExecutionModelOption = z.infer<typeof optionSchema>;

export async function executionModelCatalog() {
  const file = process.env.FINANCE_EVAL_EXECUTION_CATALOG;
  if (!file) return null;
  const catalog = catalogSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const ids = catalog.models.map(m => `${m.providerId}:${m.modelId}`);
  if (new Set(ids).size !== ids.length) throw new Error("Execution model catalog contains duplicate identities");
  if (!catalog.models.some(m => m.modelId === catalog.defaultModelId && m.availability !== "unavailable")) {
    throw new Error("Execution default model is unavailable");
  }
  // Expose only a deliberate public projection, never server credentials.
  return { ...catalog, models: catalog.models.map(({ credentialRef: _credential, ...model }) => model) };
}

export function modelReference(model: ModelRef): ModelRef {
  return { providerId: model.providerId, modelId: model.modelId, label: model.label, parameters: model.parameters };
}

export async function defaultOnlineExecutionModel(): Promise<ModelRef> {
  const catalog = await executionModelCatalog();
  return catalog ? modelReference(catalog.models.find(m => m.modelId === catalog.defaultModelId)!) : configuredModelRole("EXECUTION").model;
}

export async function resolvePublicExecutionModels(input: { executionModel?: ModelRef; leftExecutionModel?: ModelRef; rightExecutionModel?: ModelRef }) {
  const catalog = await executionModelCatalog();
  const options = catalog?.models ?? [configuredModelRole("EXECUTION").model];
  const fallback = catalog ? options.find(m => m.modelId === catalog.defaultModelId)! : options[0]!;
  const resolve = (requested?: ModelRef) => {
    const selection = requested ?? input.executionModel ?? fallback;
    const match = options.find(m => m.providerId === selection.providerId && m.modelId === selection.modelId);
    if (!match || ("availability" in match && match.availability !== "ready")) {
      throw Object.assign(new Error("所选执行模型尚未通过在线验证，请选择可用模型。"), { statusCode: 400 });
    }
    return modelReference(match);
  };
  return { leftExecutionModel: resolve(input.leftExecutionModel), rightExecutionModel: resolve(input.rightExecutionModel) };
}
