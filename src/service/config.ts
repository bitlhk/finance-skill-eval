import path from "node:path";
import { z } from "zod";
import type { ModelAdapter } from "../adapters.js";
import { CodexCliModelAdapter } from "../codex-cli-model.js";
import type { ModelRef } from "../contracts.js";
import { OpenAiCompatibleModelAdapter } from "../openai-compatible-model.js";

export type ServiceConfig = {
  rootDirectory: string;
  dataDirectory: string;
  publicDirectory: string;
  host: string;
  port: number;
  accessToken: string | null;
  maxConcurrentRuns: number;
  publicDemo?: boolean;
};

export type ConfiguredModelRole = {
  configured: boolean;
  model: ModelRef;
  adapter: ModelAdapter | null;
};

export function loadServiceConfig(): ServiceConfig {
  const rootDirectory = path.resolve(process.env.FINANCE_EVAL_ROOT ?? process.cwd());
  return {
    rootDirectory,
    dataDirectory: path.resolve(process.env.FINANCE_EVAL_DATA_DIR ?? path.join(rootDirectory, "data")),
    publicDirectory: path.resolve(process.env.FINANCE_EVAL_PUBLIC_DIR ?? path.join(rootDirectory, "web-dist")),
    host: process.env.FINANCE_EVAL_HOST?.trim() || "0.0.0.0",
    port: Number.parseInt(process.env.FINANCE_EVAL_PORT ?? "56361", 10),
    accessToken: process.env.FINANCE_EVAL_ACCESS_TOKEN?.trim() || null,
    publicDemo: process.env.FINANCE_EVAL_PUBLIC_DEMO === "true",
    maxConcurrentRuns: Math.max(
      1,
      Math.min(Number.parseInt(process.env.FINANCE_EVAL_MAX_CONCURRENT_RUNS ?? "1", 10), 4),
    ),
  };
}
function roleEnvironment(role: "ANALYZER" | "EXECUTION" | "JUDGE" | "OPTIMIZER", fallbackModel: string): {
  baseUrl: string;
  apiKey: string;
  modelId: string;
} {
  return {
    baseUrl: process.env[`FINANCE_EVAL_${role}_BASE_URL`]
      ?? process.env.FINANCE_EVAL_MODEL_BASE_URL
      ?? "",
    apiKey: process.env[`FINANCE_EVAL_${role}_API_KEY`]
      ?? process.env.FINANCE_EVAL_MODEL_API_KEY
      ?? "",
    modelId: process.env[`FINANCE_EVAL_${role}_MODEL`]
      ?? process.env.FINANCE_EVAL_MODEL
      ?? fallbackModel,
  };
}

export function configuredModelRole(
  role: "ANALYZER" | "EXECUTION" | "JUDGE" | "OPTIMIZER",
  fallbackModel = "glm-5.2",
): ConfiguredModelRole {
  const environment = roleEnvironment(role, fallbackModel);
  const provider = process.env[`FINANCE_EVAL_${role}_PROVIDER`]?.trim().toLowerCase();
  if ((role === "JUDGE" || role === "OPTIMIZER") && provider === "codex_cli") {
    return {
      configured: true,
      model: {
        providerId: "codex-host",
        modelId: process.env[`FINANCE_EVAL_${role}_MODEL`]?.trim() || "gpt-6-astra",
        label: role === "JUDGE" ? "Codex 匿名 Judge" : "Codex Skill 优化模型",
        parameters: {},
      },
      adapter: new CodexCliModelAdapter({
        executable: process.env.FINANCE_EVAL_CODEX_BIN?.trim() || "codex",
        timeoutMs: 300_000,
      }),
    };
  }
  const configured = Boolean(environment.baseUrl.trim() && environment.apiKey.trim());
  return {
    configured,
    model: {
      providerId: `service-${role.toLowerCase()}`,
      modelId: environment.modelId,
      label: `${role === "ANALYZER" ? "出题" : role === "EXECUTION" ? "执行" : "阅卷"}模型`,
      parameters: {},
    },
    adapter: configured
      ? new OpenAiCompatibleModelAdapter({
        adapterId: `service-${role.toLowerCase()}-openai-compatible-v1`,
        apiKey: environment.apiKey,
        baseUrl: environment.baseUrl,
        requestDefaults: z.record(z.unknown()).parse(JSON.parse(process.env[`FINANCE_EVAL_${role}_REQUEST_DEFAULTS`] ?? "{}")),
        timeoutMs: role === "JUDGE" ? 240_000 : 180_000,
      })
      : null,
  };
}
