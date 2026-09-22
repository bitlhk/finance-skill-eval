import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { modelRefSchema, type ModelRef } from "../contracts.js";

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

export async function executionModelCatalog(rootDirectory = process.cwd()) {
  const configuredFile = process.env.FINANCE_EVAL_EXECUTION_CATALOG?.trim();
  const files = configuredFile
    ? [path.resolve(rootDirectory, configuredFile)]
    : [path.resolve(rootDirectory, ".models.local.json"), path.resolve(rootDirectory, "config/execution-models.json")];
  let source: string | null = null;
  for (const file of files) {
    source = await readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT" && !configuredFile) return null;
      throw error;
    });
    if (source !== null) break;
  }
  if (source === null) return null;
  const catalog = catalogSchema.parse(JSON.parse(source));
  const ids = catalog.models.map(m => `${m.providerId}:${m.modelId}`);
  if (new Set(ids).size !== ids.length) throw new Error("Execution model catalog contains duplicate identities");
  if (!catalog.models.some(m => m.modelId === catalog.defaultModelId && m.availability === "ready")) {
    throw new Error("Execution default model must be ready");
  }
  // Expose only a deliberate public projection, never server credentials.
  return { ...catalog, models: catalog.models.map(({ credentialRef: _credential, ...model }) => model) };
}

export function modelReference(model: ModelRef): ModelRef {
  return { providerId: model.providerId, modelId: model.modelId, label: model.label, parameters: model.parameters };
}

function missingCatalog(): Error & { statusCode: number } {
  return Object.assign(new Error("后端尚未配置可用的执行模型列表。"), { statusCode: 503 });
}

export async function defaultOnlineExecutionModel(rootDirectory = process.cwd()): Promise<ModelRef> {
  const catalog = await executionModelCatalog(rootDirectory);
  if (!catalog) throw missingCatalog();
  return modelReference(catalog.models.find(m => m.modelId === catalog.defaultModelId)!);
}

export async function resolvePublicExecutionModels(
  input: { executionModel?: ModelRef; leftExecutionModel?: ModelRef; rightExecutionModel?: ModelRef },
  rootDirectory = process.cwd(),
) {
  const catalog = await executionModelCatalog(rootDirectory);
  if (!catalog) throw missingCatalog();
  const options = catalog.models;
  const fallback = options.find(m => m.modelId === catalog.defaultModelId)!;
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
