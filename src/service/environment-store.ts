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
}
