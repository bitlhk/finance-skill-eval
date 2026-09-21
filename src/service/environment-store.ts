import { randomUUID } from "node:crypto";
import path from "node:path";
import { unlink } from "node:fs/promises";
import { KeyedQueue } from "../shared/keyed-queue.js";
import { preflightMcpServer, type McpPreflightResult } from "../mcp-preflight.js";
import {
  createEnvironmentSchema,
  environmentRecordSchema,
  type EnvironmentRecord,
} from "../shared/contracts/environment.js";
import { ensureDirectory, listJsonFiles, readJson, writeJsonAtomic } from "./file-store.js";
import { runtimeLauncherCapabilitiesSchema, type RuntimeLauncherCapabilities } from '../runtime-launcher.js';

function headersFor(record: EnvironmentRecord): Record<string, string> {
  if (!record.credentialEnv) return {};
  const credential = process.env[record.credentialEnv];
  if (!credential) throw new Error(`Credential environment variable is unavailable: ${record.credentialEnv}`);
  return { authorization: credential.startsWith("Bearer ") ? credential : `Bearer ${credential}` };
}
export class EnvironmentStore {
  private readonly directory: string;
  private readonly writes = new KeyedQueue();

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
    return this.writes.run("registry", async () => {
    const parsed = createEnvironmentSchema.parse(input);
    if(parsed.type==='runtime_http')await this.validateBindings(parsed.mcpEnvironmentIds);
    const now = new Date().toISOString();
    const record = environmentRecordSchema.parse({
      ...parsed,
      runtimeType: parsed.type === 'runtime_launcher'?parsed.runtimeType:parsed.type === "runtime_http"?parsed.runtimeType ?? "generic_http":null,
      credentialEnv: parsed.credentialEnv ?? null,
      environmentId: `env-${randomUUID().slice(0, 12)}`,
      createdAt: now,
      updatedAt: now,
    });
    await writeJsonAtomic(path.join(this.directory, `${record.environmentId}.json`), record);
    return record;
    });
  }

  private async validateBindings(ids: string[]): Promise<void> {
    for (const id of ids) {
      const record = await this.get(id);
      if (!record || record.type !== "mcp_streamable_http") {
        throw Object.assign(new Error(`MCP binding is unavailable: ${id}`), { statusCode: 400 });
      }
    }
  }

  async update(id: string, input: unknown): Promise<EnvironmentRecord> {
    return this.writes.run("registry", async () => {
      const previous = await this.get(id);
      if (!previous) throw Object.assign(new Error("Environment not found"), { statusCode: 404 });
      const parsed = createEnvironmentSchema.parse(input);
      if (parsed.type !== previous.type) {
        throw Object.assign(new Error("Resource type cannot change; create a new environment instead"), { statusCode: 409 });
      }
      if(parsed.type==='runtime_http')await this.validateBindings(parsed.mcpEnvironmentIds);
      const record = environmentRecordSchema.parse({
        ...previous, ...parsed,
        runtimeType: parsed.type === 'runtime_launcher'?parsed.runtimeType:parsed.type === "runtime_http"?parsed.runtimeType ?? "generic_http":null,
        credentialEnv: parsed.credentialEnv ?? null,
        updatedAt: new Date().toISOString(),
      });
      await writeJsonAtomic(path.join(this.directory, `${id}.json`), record);
      return record;
    });
  }

  async remove(id: string): Promise<void> {
    await this.writes.run("registry", async () => {
      if (!await this.get(id)) throw Object.assign(new Error("Environment not found"), { statusCode: 404 });
      const dependent = (await this.list()).find(record => 'mcpEnvironmentIds' in record&&record.mcpEnvironmentIds.includes(id));
      if (dependent) throw Object.assign(new Error(`Environment is still bound by ${dependent.name}`), { statusCode: 409 });
      await unlink(path.join(this.directory, `${id}.json`));
    });
  }

  headers(record: EnvironmentRecord): Record<string, string> {
    return headersFor(record);
  }

  async preflight(record: EnvironmentRecord): Promise<McpPreflightResult | {
    status: "ready" | "failed";
    elapsedMs: number;
    error: string | null;
    capabilities?:RuntimeLauncherCapabilities;
  }> {
    if(record.type==='runtime_launcher'){
      const startedAt=Date.now();
      try{
        const response=await fetch(new URL('v1/runtime-capabilities',record.baseUrl),{headers:headersFor(record),signal:AbortSignal.timeout(10_000),redirect:'error'});
        if(!response.ok)throw new Error(`HTTP ${response.status}`);
        const capabilities=runtimeLauncherCapabilitiesSchema.parse(await response.json());
        if(record.runtimeType!=='generic_http'&&capabilities.runtime.type!==record.runtimeType)throw new Error('Runtime type does not match the registered Launcher');
        return {status:'ready',elapsedMs:Date.now()-startedAt,error:null,capabilities};
      }catch(error){return {status:'failed',elapsedMs:Date.now()-startedAt,error:error instanceof Error?error.message:String(error)};}
    }
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
        redirect: "error",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (record.runtimeType === "openjiuwen") {
        const health = await response.json() as { mcpEndpoints?: unknown; status?: string };
        if (health.status && health.status !== "ready") throw new Error("Runtime is not ready");
        if (record.mcpEnvironmentIds.length) {
          if (!Array.isArray(health.mcpEndpoints) || !health.mcpEndpoints.every(item => typeof item === "string")) {
            throw new Error("Runtime 未声明 MCP 接入能力，无法确认绑定可执行；请升级 Runtime 的 /health 接口。");
          }
          for (const id of record.mcpEnvironmentIds) {
            const mcp = await this.get(id);
            if (!mcp || mcp.type!=='mcp_streamable_http' || !health.mcpEndpoints.includes(mcp.endpoint)) {
              throw new Error(`Runtime 尚未接受 MCP「${mcp?.name ?? id}」；服务连通不代表 Runtime 已装配，请检查 Runtime 配置。`);
            }
          }
        }
      }
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
    capabilities?:RuntimeLauncherCapabilities;
  }> {
    const startedAt = Date.now();
    const primary = await this.preflight(record);
    if(record.type==='runtime_launcher')return {status:primary.status,elapsedMs:Date.now()-startedAt,error:primary.error,toolCount:0,tools:[],mcpServers:[],...('capabilities' in primary&&primary.capabilities?{capabilities:primary.capabilities}:{})};
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
