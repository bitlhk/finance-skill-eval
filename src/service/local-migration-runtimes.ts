import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ModelRef } from "../contracts.js";
import type { EnvironmentRecord } from "./contracts.js";

const configuredModelSchema = z.object({
  providerId: z.string().min(1).optional(),
  label: z.string().min(1).optional(),
  providerLabel: z.string().min(1).optional(),
  baseUrl: z.string().min(1),
  apiKey: z.string().min(1),
  upstreamModelId: z.string().min(1),
  enabled: z.boolean().optional(),
}).passthrough();

const runtimeConfigSchema = z.object({
  defaultModelId: z.string().min(1).optional(),
  models: z.record(configuredModelSchema),
  mcp: z.record(z.unknown()).optional(),
}).passthrough();

export type LocalMigrationRuntimeModel = ModelRef & {
  upstreamModelId: string;
  availability: "ready";
  providerLabel?: string;
  statusNote: string;
};

export type LocalMigrationRuntime = {
  runtimeId: string;
  name: string;
  runtimeType: "openjiuwen";
  endpoint: string;
  configFile: string;
  defaultModelId: string;
  models: LocalMigrationRuntimeModel[];
};

function notFound(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 400 });
}

/**
 * Runtime definitions used by Skill migration are deliberately local and trusted. They do not
 * come from EnvironmentStore: that registry cannot configure a user-owned Runtime's models/MCPs.
 * Credentials remain in FINANCE_RUNTIME_CONFIG and only this public projection reaches the UI.
 */
export class LocalMigrationRuntimeCatalog {
  constructor(private readonly rootDirectory: string) {}

  private configFile(): string {
    const configured = process.env.FINANCE_RUNTIME_CONFIG?.trim();
    return configured ? path.resolve(this.rootDirectory, configured) : path.resolve(this.rootDirectory, ".runtime.local.json");
  }

  async list(): Promise<LocalMigrationRuntime[]> {
    const configFile = this.configFile();
    const source = await readFile(configFile, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (source === null) return [];
    const config = runtimeConfigSchema.parse(JSON.parse(source));
    const models = Object.entries(config.models)
      .filter(([, model]) => model.enabled !== false)
      .map(([modelId, model]) => ({
        providerId: model.providerId ?? "service-execution",
        modelId,
        upstreamModelId: model.upstreamModelId,
        label: model.label ?? modelId,
        ...(model.providerLabel ? { providerLabel: model.providerLabel } : {}),
        parameters: {},
        availability: "ready" as const,
        statusNote: "由本地 Runtime 配置提供",
      }));
    if (!models.length) return [];
    const defaultModelId = config.defaultModelId ?? models[0]!.modelId;
    if (!models.some(model => model.modelId === defaultModelId)) {
      throw new Error(`Local Runtime default model is unavailable: ${defaultModelId}`);
    }
    return [{
      runtimeId: process.env.FINANCE_MIGRATION_RUNTIME_ID?.trim() || "local-openjiuwen",
      name: process.env.FINANCE_MIGRATION_RUNTIME_NAME?.trim() || "本地 OpenJiuwen Runtime",
      runtimeType: "openjiuwen",
      endpoint: process.env.FINANCE_OPENJIUWEN_ENDPOINT?.trim() || "http://127.0.0.1:56362/execute",
      configFile,
      defaultModelId,
      models,
    }];
  }

  async get(runtimeId: string): Promise<LocalMigrationRuntime | null> {
    return (await this.list()).find(runtime => runtime.runtimeId === runtimeId) ?? null;
  }

  async environment(runtimeId: string): Promise<EnvironmentRecord | null> {
    const runtime = await this.get(runtimeId);
    if (!runtime) return null;
    const now = new Date(0).toISOString();
    return {
      environmentId: runtime.runtimeId,
      name: runtime.name,
      type: "runtime_http",
      runtimeType: runtime.runtimeType,
      endpoint: runtime.endpoint,
      credentialEnv: null,
      // Candidate MCP services are delivered per execution. Never inherit the legacy test
      // environment bindings or turn the Runtime's private base MCP config into a UI registry.
      mcpEnvironmentIds: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  async resolveModel(runtimeId: string, requested?: ModelRef): Promise<ModelRef> {
    const runtime = await this.get(runtimeId);
    if (!runtime) throw notFound("所选本地 Runtime 不存在或未配置。");
    const selection = requested ?? runtime.models.find(model => model.modelId === runtime.defaultModelId);
    const match = selection && runtime.models.find(model => model.modelId === selection.modelId && model.providerId === selection.providerId);
    if (!match) throw notFound("所选执行模型不属于这个本地 Runtime。");
    return { providerId: match.providerId, modelId: match.modelId, label: match.label, parameters: match.parameters };
  }

  async publicList(): Promise<Array<Omit<LocalMigrationRuntime, "configFile">>> {
    return (await this.list()).map(({ configFile: _configFile, ...runtime }) => runtime);
  }
}
