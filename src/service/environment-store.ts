import { randomUUID } from "node:crypto";
import path from "node:path";
import { preflightMcpServer, type McpPreflightResult } from "../mcp-preflight.js";
import {
  createEnvironmentSchema,
  environmentRecordSchema,
  type EnvironmentRecord,
} from "./contracts.js";
import { ensureDirectory, listJsonFiles, readJson, writeJsonAtomic } from "./file-store.js";

function headersFor(record: EnvironmentRecord): Record<string, string> {
  if (!record.credentialEnv) return {};
  const credential = process.env[record.credentialEnv];
  if (!credential) throw new Error(`Credential environment variable is unavailable: ${record.credentialEnv}`);
  return { authorization: credential.startsWith("Bearer ") ? credential : `Bearer ${credential}` };
}
export class EnvironmentStore {
  private readonly directory: string;

  constructor(dataDirectory: string) {
    this.directory = path.join(dataDirectory, "environments");
  }

  async initialize(): Promise<void> {
    await ensureDirectory(this.directory);
  }

  async list(): Promise<EnvironmentRecord[]> {
    const records = await Promise.all(
      (await listJsonFiles(this.directory)).map(file => readJson<EnvironmentRecord>(file)),
    );
    return records.map(record => environmentRecordSchema.parse(record))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async get(environmentId: string): Promise<EnvironmentRecord | null> {
    if (!/^[a-z0-9-]+$/u.test(environmentId)) return null;
    try {
      return environmentRecordSchema.parse(
        await readJson(path.join(this.directory, `${environmentId}.json`)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async create(input: unknown): Promise<EnvironmentRecord> {
    const parsed = createEnvironmentSchema.parse(input);
    const now = new Date().toISOString();
    const record = environmentRecordSchema.parse({
      ...parsed,
      runtimeType: parsed.type === "runtime_http"
        ? parsed.runtimeType ?? "generic_http"
        : null,
      credentialEnv: parsed.credentialEnv ?? null,
      environmentId: `env-${randomUUID().slice(0, 12)}`,
      createdAt: now,
      updatedAt: now,
    });
    await writeJsonAtomic(path.join(this.directory, `${record.environmentId}.json`), record);
    return record;
  }

  headers(record: EnvironmentRecord): Record<string, string> {
    return headersFor(record);
  }

  async preflight(record: EnvironmentRecord): Promise<McpPreflightResult | {
    status: "ready" | "failed";
    elapsedMs: number;
    error: string | null;
  }> {
    if (record.type === "mcp_streamable_http") {
      return preflightMcpServer({ endpoint: record.endpoint, headers: headersFor(record) });
    }
    const startedAt = Date.now();
    try {
      const url = new URL(record.endpoint);
      url.pathname = url.pathname.replace(/\/execute\/?$/, "/health");
      const response = await fetch(url, {
        headers: headersFor(record),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { status: "ready", elapsedMs: Date.now() - startedAt, error: null };
    } catch (error) {
      return {
        status: "failed",
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async inspect(record: EnvironmentRecord): Promise<{
    status: "ready" | "failed";
    elapsedMs: number;
    error: string | null;
    toolCount: number;
    tools: Array<{ name: string }>;
    mcpServers: Array<{
      environmentId: string;
      name: string;
      status: "ready" | "failed";
      toolNames: string[];
      error: string | null;
    }>;
  }> {
    const startedAt = Date.now();
    const primary = await this.preflight(record);
    if (record.type === "mcp_streamable_http") {
      const tools = primary.status === "ready" && "tools" in primary ? primary.tools : [];
      return {
        status: primary.status,
        elapsedMs: Date.now() - startedAt,
        error: primary.error,
        toolCount: tools.length,
        tools: tools.map(tool => ({ name: tool.name })),
        mcpServers: [{ environmentId: record.environmentId, name: record.name, status: primary.status, toolNames: tools.map(tool => tool.name), error: primary.error }],
      };
    }

    const mcpServers = [];
    const allTools: Array<{ name: string }> = [];
    for (const environmentId of record.mcpEnvironmentIds) {
      const environment = await this.get(environmentId);
      if (!environment || environment.type !== "mcp_streamable_http") {
        mcpServers.push({
          environmentId,
          name: environmentId,
          status: "failed" as const,
          toolNames: [],
          error: "MCP 环境不存在",
        });
        continue;
      }
      const result = await this.preflight(environment);
      const tools = result.status === "ready" && "tools" in result ? result.tools : [];
      allTools.push(...tools.map(tool => ({ name: tool.name })));
      mcpServers.push({
        environmentId,
        name: environment.name,
        status: result.status,
        toolNames: tools.map(tool => tool.name),
        error: result.error,
      });
    }
    const failedMcp = mcpServers.find(item => item.status === "failed");
    return {
      status: primary.status === "ready" && !failedMcp ? "ready" : "failed",
      elapsedMs: Date.now() - startedAt,
      error: primary.error ?? failedMcp?.error ?? null,
      toolCount: allTools.length,
      tools: allTools,
      mcpServers,
    };
  }
}
