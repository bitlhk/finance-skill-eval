import path from "node:path";
import { accessSync, constants, statSync } from "node:fs";
import { z } from "zod";
import type { ModelAdapter } from "../adapters.js";
import { CodexCliModelAdapter } from "../codex-cli-model.js";
import type { ModelRef } from "../contracts.js";
import { OpenAiCompatibleModelAdapter } from "../openai-compatible-model.js";
import { runtimeLauncherBaseUrlSchema } from "../shared/contracts/runtime-launcher.js";
import type {WorkspaceRequestLimits} from './workspace-request-budget.js';

export type ServiceConfig = {
  rootDirectory: string;
  dataDirectory: string;
  publicDirectory: string;
  host: string;
  port: number;
  accessToken: string | null;
  maxConcurrentRuns: number;
  publicDemo?: boolean;
  workspaceSubject?: string;
  workspaceOrigin?: string;
  workspaceMode?: 'single' | 'account';
  workspaceSeedDirectory?: string;
  workspaceSeedSha256?: string;
  workspaceMaxAccounts?: number;
  workspaceRequestLimits?: WorkspaceRequestLimits;
  workspacePreflightLimits?: WorkspaceRequestLimits;
  /** Internal account-service policy; not a browser-selected option. */
  managedWorkspace?: boolean;
  launcherTrust?:Array<{reference:string;label:string;baseUrlPrefix:string;credentialEnv:string|null}>;
};

const launcherTrustSchema=z.array(z.strictObject({
  reference:z.string().regex(/^[a-z0-9-]+$/u),label:z.string().min(1),baseUrlPrefix:runtimeLauncherBaseUrlSchema,
  credentialEnv:z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u).nullable().default(null),
})).superRefine((items,context)=>{if(new Set(items.map(item=>item.reference)).size!==items.length)context.addIssue({code:'custom',message:'Launcher trust references must be unique'});});

function launcherTrustConfiguration(){
  const raw=process.env.FINANCE_EVAL_LAUNCHER_TRUST_JSON?.trim();
  if(!raw)return [];
  return launcherTrustSchema.parse(JSON.parse(raw));
}

export type ConfiguredModelRole = {
  configured: boolean;
  model: ModelRef;
  adapter: ModelAdapter | null;
};

export function loadServiceConfig(): ServiceConfig {
  const rootDirectory = path.resolve(process.env.FINANCE_EVAL_ROOT ?? process.cwd());
  const workspaceMode=z.enum(['single','account']).parse(process.env.FINANCE_EVAL_WORKSPACE_MODE??'single');
  return {
    rootDirectory,
    dataDirectory: path.resolve(process.env.FINANCE_EVAL_DATA_DIR ?? path.join(rootDirectory, "data")),
    publicDirectory: path.resolve(process.env.FINANCE_EVAL_PUBLIC_DIR ?? path.join(rootDirectory, "web-dist")),
    host: process.env.FINANCE_EVAL_HOST?.trim() || "0.0.0.0",
    port: Number.parseInt(process.env.FINANCE_EVAL_PORT ?? "56361", 10),
    accessToken: process.env.FINANCE_EVAL_ACCESS_TOKEN?.trim() || null,
    publicDemo: process.env.FINANCE_EVAL_PUBLIC_DEMO === "true",
    workspaceSubject: process.env.FINANCE_EVAL_WORKSPACE_SUBJECT?.trim() || undefined,
    workspaceOrigin: process.env.FINANCE_EVAL_WORKSPACE_ORIGIN?.trim() || undefined,
    workspaceMode,
    workspaceSeedDirectory:process.env.FINANCE_EVAL_WORKSPACE_SEED_DIRECTORY?.trim()||undefined,
    workspaceSeedSha256:process.env.FINANCE_EVAL_WORKSPACE_SEED_SHA256?.trim()||undefined,
    workspaceMaxAccounts:Number(process.env.FINANCE_EVAL_WORKSPACE_MAX_ACCOUNTS??64),
    workspaceRequestLimits:{
      perAccount:Number(process.env.FINANCE_EVAL_WORKSPACE_REQUESTS_PER_ACCOUNT??20),
      global:Number(process.env.FINANCE_EVAL_WORKSPACE_REQUESTS_GLOBAL??80),
      windowSeconds:Number(process.env.FINANCE_EVAL_WORKSPACE_REQUEST_WINDOW_SECONDS??60),
    },
    workspacePreflightLimits:{
      perAccount:Number(process.env.FINANCE_EVAL_WORKSPACE_PREFLIGHTS_PER_ACCOUNT??60),
      global:Number(process.env.FINANCE_EVAL_WORKSPACE_PREFLIGHTS_GLOBAL??240),
      windowSeconds:Number(process.env.FINANCE_EVAL_WORKSPACE_REQUEST_WINDOW_SECONDS??60),
    },
    launcherTrust:launcherTrustConfiguration(),
    maxConcurrentRuns: Math.max(
      1,
      Math.min(Number.parseInt(process.env.FINANCE_EVAL_MAX_CONCURRENT_RUNS ?? "1", 10), 4),
    ),
  };
}
export type ModelRole = "ANALYZER" | "EXECUTION" | "JUDGE" | "OPTIMIZER" | "MIGRATION";
function roleEnvironment(role: ModelRole, fallbackModel: string): {
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
  role: ModelRole,
  fallbackModel = "glm-5.2",
): ConfiguredModelRole {
  const environment = roleEnvironment(role, fallbackModel);
  const provider = process.env[`FINANCE_EVAL_${role}_PROVIDER`]?.trim().toLowerCase();
  if ((role === "JUDGE" || role === "OPTIMIZER" || role === "MIGRATION") && provider === "codex_cli") {
    const command = process.env.FINANCE_EVAL_CODEX_BIN?.trim() || "codex";
    const candidates = path.isAbsolute(command) || command.includes("/") || command.includes("\\")
      ? [path.resolve(command)]
      : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.resolve(dir, command));
    const executable = candidates.find(candidate => {
      try { accessSync(candidate, constants.X_OK); return statSync(candidate).isFile(); }
      catch { return false; }
    });
    return {
      // Executable readiness is not a claim that remote authentication/model access was verified.
      configured: Boolean(executable),
      model: {
        providerId: "codex-host",
        modelId: process.env[`FINANCE_EVAL_${role}_MODEL`]?.trim() || "gpt-6-astra",
        label: role === "JUDGE" ? "Codex 匿名 Judge" : role === "MIGRATION" ? "Codex 代码迁移模型" : "Codex Skill 优化模型",
        parameters: {},
      },
      adapter: executable ? new CodexCliModelAdapter({
        executable,
        timeoutMs: 300_000,
      }) : null,
    };
  }
  const configured = Boolean(environment.baseUrl.trim() && environment.apiKey.trim());
  return {
    configured,
    model: {
      providerId: `service-${role.toLowerCase()}`,
      modelId: environment.modelId,
      label: `${role === "ANALYZER" ? "出题" : role === "EXECUTION" ? "执行" : role === "MIGRATION" ? "代码迁移" : "阅卷"}模型`,
      parameters: {},
    },
    adapter: configured
      ? new OpenAiCompatibleModelAdapter({
        adapterId: `service-${role.toLowerCase()}-openai-compatible-v1`,
        apiKey: environment.apiKey,
        baseUrl: environment.baseUrl,
        requestDefaults: z.record(z.unknown()).parse(JSON.parse(process.env[`FINANCE_EVAL_${role}_REQUEST_DEFAULTS`] ?? "{}")),
        timeoutMs: modelTimeoutMs(role),
      })
      : null,
  };
}

/**
 * How long one completion may take, per role.
 *
 * The question writer's budget is the one that was wrong. Writing a test set is the same request
 * every time and the model's answer is not: measured over three consecutive runs against
 * `deepseek-v4-flash`, it took 36 s when the model reasoned briefly and 185 s and 147 s when it
 * reasoned for ~20k tokens. A 180 s ceiling sits inside that spread, so the stage fails on a
 * schedule nobody can see -- and reads as a timeout, which sounds like a hang rather than a
 * budget. Reasoning length is the model's call, not ours, so the ceiling has to clear the tail
 * instead of the median.
 *
 * Each role can be pinned from the environment, which is what an operator needs when the model
 * behind a role changes: the failure is intermittent, and the fix should not require a release.
 */
export function modelTimeoutMs(role: ModelRole): number {
  const configuredMs = Number.parseInt(process.env[`FINANCE_EVAL_${role}_TIMEOUT_MS`] ?? "", 10);
  if (Number.isFinite(configuredMs) && configuredMs > 0) return configuredMs;
  if (role === "JUDGE") return 240_000;
  if (role === "ANALYZER") return 600_000;
  if (role === "MIGRATION") return 300_000;
  return 180_000;
}
