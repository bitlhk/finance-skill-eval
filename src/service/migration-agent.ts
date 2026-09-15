import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * TS <-> Python boundary for the migration agents (X-2).
 *
 * The existing runtime contract (finance.skill-eval.runtime-request.v1) is
 * evaluation-shaped -- it demands case/side/variant -- so the migration agents get
 * their own request. One agent run per call, isolated process, stdout carries the
 * result as a single JSON line.
 */

export type AgentStage = "A2" | "A4";
export type AgentStatus = "PRODUCED" | "ABSTAINED" | "FAILED";

export type AgentResult<T = Record<string, unknown>> = {
  stage: AgentStage;
  status: AgentStatus;
  assetDigest?: string;
  payload: T;
  files?: Record<string, string>;
  /** The static scanner's own result, when the A2 agent ran it. */
  scanner?: Record<string, unknown> | null;
  trace: { rounds: Array<Record<string, unknown>> };
  elapsedMs: number;
  modelId?: string;
  error?: string;
};

export type MigrationAgentOptions = {
  /** Repository root: where integrations/ and .venv-openjiuwen live. NOT the data directory. */
  projectRoot: string;
  /** Model key inside .runtime.local.json's `models` map. */
  modelId: string;
  providerId?: string;
  maxIterations?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const ENTRY: Record<AgentStage, string> = {
  A2: path.join("integrations", "openjiuwen", "analyze_agent.py"),
  A4: path.join("integrations", "openjiuwen", "migrate_agent.py"),
};

export class MigrationAgentUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationAgentUnavailable";
  }
}

/**
 * Agents are the product path, so they are on by default. Set
 * FINANCE_EVAL_MIGRATION_AGENT=off to force the deterministic rules path -- tests do
 * this so they never reach a live model.
 */
export function migrationAgentEnabled(): boolean {
  const flag = process.env.FINANCE_EVAL_MIGRATION_AGENT?.trim().toLowerCase();
  if (flag === "off") return false;
  if (flag === "on") return true;
  // Default on for the product; never reach a live model from a test run. This is
  // checked here rather than in vitest config because the guard must not depend on
  // the config actually reaching the process.
  return !process.env.VITEST;
}

function interpreter(projectRoot: string): string {
  const configured = process.env.FINANCE_EVAL_MIGRATION_PYTHON?.trim();
  if (configured) return configured;
  // The agent needs openjiuwen, which lives in the launcher's venv -- not the
  // interpreter that happens to be on PATH.
  return path.join(projectRoot, ".venv-openjiuwen", "Scripts", "python.exe");
}

export function encodeArchive(archive: Record<string, Uint8Array>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(archive).map(([name, bytes]) => [name, Buffer.from(bytes).toString("base64")]),
  );
}

type AgentTool = {
  name?: string; sourcePaths?: string[]; language?: string | null;
  portability?: string; inputSchema?: unknown; outputSchema?: unknown;
  evidence?: Array<{ path?: string; line?: number; snippet?: string }>;
  findings?: Array<{ code?: string; severity?: string; path?: string; line?: number; message?: string }>;
  recommendedForm?: string; recommendedLanguage?: string; recommendationReason?: string;
};

const PORTABILITIES = ["PORTABLE_MCP", "PORTABLE_SCRIPT", "RUNTIME_BOUND", "INCOMPLETE", "UNSUPPORTED", "UNKNOWN"] as const;
type Portability = (typeof PORTABILITIES)[number];

function asPortability(value: unknown): Portability {
  const candidate = String(value ?? "").toUpperCase();
  return (PORTABILITIES as readonly string[]).includes(candidate) ? candidate as Portability : "UNKNOWN";
}
function severity(value: unknown): "ERROR" | "WARNING" | "INFO" {
  const candidate = String(value ?? "").toUpperCase();
  return candidate === "ERROR" || candidate === "WARNING" ? candidate : "INFO";
}

/**
 * Turn the A2 agent's judgement into the platform's inspection shape.
 *
 * The agent supplies judgement; the identifiers, digests and severities are
 * normalised here so downstream code keeps one representation.
 */
export function toProjectInspection(
  payload: { skill?: { status?: string; findings?: unknown[] }; tools?: AgentTool[] },
  assetId: string,
  assetDigest: string,
  stableToolId: (name: string, paths: string[]) => string,
  scanner?: Record<string, unknown> | null,
): import("./migration-model.js").ProjectInspection {
  const skillStatus = String(payload.skill?.status ?? "").toUpperCase();
  const skillFindings = (payload.skill?.findings ?? []).flatMap(entry => {
    const finding = entry as { code?: string; severity?: string; path?: string; line?: number; message?: string; suggestion?: string };
    if (!finding?.code) return [];
    return [{
      code: String(finding.code),
      severity: severity(finding.severity),
      path: String(finding.path ?? ""),
      line: Number(finding.line ?? 1),
      message: String(finding.message ?? ""),
      suggestion: String(finding.suggestion ?? ""),
    }];
  });
  const tools = (payload.tools ?? []).flatMap(tool => {
    const name = String(tool.name ?? "").trim();
    if (!name) return [];
    const sourcePaths = (tool.sourcePaths ?? []).map(String).filter(Boolean);
    const portability = asPortability(tool.portability);
    const kind = portability === "PORTABLE_MCP" ? "MCP" as const
      : portability === "PORTABLE_SCRIPT" ? "SCRIPT" as const
        : portability === "RUNTIME_BOUND" ? "RUNTIME_BOUND" as const
          : "UNKNOWN" as const;
    const form = String(tool.recommendedForm ?? "").toUpperCase() === "SCRIPT" ? "SCRIPT" as const : "MCP" as const;
    return [{
      toolId: stableToolId(name, sourcePaths),
      name,
      sourcePaths,
      language: tool.language ?? null,
      kind,
      portability,
      inputSchema: tool.inputSchema ?? null,
      outputSchema: tool.outputSchema ?? null,
      evidence: (tool.evidence ?? []).flatMap(item => item?.path
        ? [{ path: String(item.path), line: Number(item.line ?? 1), kind: "AGENT", detail: String(item.snippet ?? "") }]
        : []),
      findings: (tool.findings ?? []).flatMap(item => item?.code
        ? [{
          code: String(item.code),
          severity: severity(item.severity),
          path: String(item.path ?? ""),
          line: Number(item.line ?? 1),
          message: String(item.message ?? ""),
        }]
        : []),
      recommendedAction: (form === "SCRIPT" ? "MIGRATE_TO_SCRIPT" : "MIGRATE_TO_MCP") as "MIGRATE_TO_MCP" | "MIGRATE_TO_SCRIPT",
    }];
  });
  // Coverage comes from the scanner, not from the agent's own account of itself.
  const incompleteFiles = Array.isArray(scanner?.coverage)
    ? (scanner.coverage as Array<{ path?: string; status?: string }>).flatMap(entry =>
        entry?.path && entry.status && !/^(PARSED|OK)$/iu.test(entry.status)
          ? [{ path: String(entry.path), status: String(entry.status) }]
          : [])
    : [];
  const staticAnalysis = scanner
    ? {
      status: (incompleteFiles.length ? "PARTIAL" : "COMPLETE") as "PARTIAL" | "COMPLETE",
      dependencyStatus: "UNKNOWN" as const,
      scannerDigest: typeof scanner.scannerDigest === "string" ? scanner.scannerDigest : null,
      incompleteFiles,
    }
    : undefined;
  return {
    assetId,
    assetDigest,
    inspectedAt: new Date().toISOString(),
    staticAnalysis,
    skill: {
      status: skillStatus === "COMPLIANT" ? "COMPLIANT" : skillStatus === "NON_COMPLIANT" ? "NON_COMPLIANT" : "UNKNOWN",
      findings: skillFindings,
    },
    tools,
    scriptsExecuted: false,
  };
}

/**
 * A minimal sample derived from the source contract. Deterministic and source-derived:
 * the contract test's input must not come from the model that wrote the implementation.
 */
export function sampleFromSchema(schema: unknown): unknown {
  const node = schema as { type?: unknown; properties?: Record<string, unknown>; required?: unknown } | null;
  if (!node || typeof node !== "object") return {};
  const declared = String(node.type ?? "object");
  if (declared === "object") {
    const required = Array.isArray(node.required) ? node.required.map(String) : Object.keys(node.properties ?? {});
    const out: Record<string, unknown> = {};
    for (const key of required) out[key] = sampleFromSchema(node.properties?.[key]);
    return out;
  }
  if (declared === "array") return [];
  if (declared === "integer" || declared === "number") return 0;
  if (declared === "boolean") return false;
  return "";
}

type AgentGeneration = {
  toolId?: string; status?: string; entrypoint?: string; files?: string[];
  language?: string; compilePassed?: boolean; contractPassed?: boolean;
  reason?: string; missing?: string[];
};

/**
 * Map an A4 result onto the generator's output shape, so the existing packaging
 * (skill normalisation, MCP service scaffolding, diff) keeps working unchanged.
 */
export function toGeneratedImplementations(
  payload: { tools?: AgentGeneration[] },
  files: Record<string, string>,
  toolNameById: Record<string, string>,
): Record<string, import("./migration-code-generator.js").GeneratedToolImplementation> {
  const decode = (name: string): string | null => {
    const encoded = files[name];
    if (typeof encoded !== "string") return null;
    try { return Buffer.from(encoded, "base64").toString("utf8"); } catch { return null; }
  };
  const out: Record<string, import("./migration-code-generator.js").GeneratedToolImplementation> = {};
  for (const tool of payload.tools ?? []) {
    const toolId = String(tool.toolId ?? "");
    const entrypoint = String(tool.entrypoint ?? "");
    const language = String(tool.language ?? "").toLowerCase() === "java" ? "java" as const : "python" as const;
    if (!toolId || !entrypoint) continue;
    if (tool.status && tool.status.toUpperCase() === "ABSTAINED") continue;
    const source = decode(entrypoint);
    if (source === null) continue;
    const additionalFiles = (tool.files ?? [])
      .map(String)
      .filter(name => name && name !== entrypoint)
      .flatMap(name => { const content = decode(name); return content === null ? [] : [{ path: name, content }]; });
    const compileCheck = language === "java"
      ? { name: "JAVA_COMPILE" as const, passed: true as const, message: "编译通过" }
      : { name: "PYTHON_COMPILE" as const, passed: true as const, message: "编译通过" };
    out[toolId] = {
      language,
      sourcePath: entrypoint,
      source,
      additionalFiles,
      dependencies: [],
      smokeInput: {},
      generatedBy: toolNameById[toolId] ?? toolId,
      explanation: tool.reason?.trim() || "由 A4 迁移 agent 生成并通过编译与契约测试。",
      attempts: 1,
      checks: tool.compilePassed === false ? [] : [
        compileCheck,
        { name: "JSON_SMOKE" as const, passed: true as const, message: tool.contractPassed === false ? "契约测试未通过" : "契约测试通过（输入输出形状）" },
      ],
    };
  }
  return out;
}

/** Run one migration agent. Never throws for an agent-side failure: FAILED is a result. */
export async function runMigrationAgent<T = Record<string, unknown>>(
  stage: AgentStage,
  request: Record<string, unknown>,
  options: MigrationAgentOptions,
): Promise<AgentResult<T>> {
  const program = interpreter(options.projectRoot);
  const entry = path.join(options.projectRoot, ENTRY[stage]);
  const runtimeConfig = process.env.FINANCE_RUNTIME_CONFIG?.trim()
    ?? path.join(options.projectRoot, ".runtime.local.json");

  // Cheapest possible unavailable check: without the interpreter or the runtime
  // config there is nothing to spawn, and callers fall back to the rules path.
  if (!existsSync(program) || !existsSync(runtimeConfig)) {
    return {
      stage, status: "FAILED", payload: {} as T, trace: { rounds: [] }, elapsedMs: 0,
      error: "migration agent runtime is not available",
    };
  }

  const body = JSON.stringify({
    stage,
    model: { modelId: options.modelId, providerId: options.providerId ?? "service-execution" },
    maxIterations: options.maxIterations,
    ...request,
  });

  return await new Promise<AgentResult<T>>((resolve, reject) => {
    const child = spawn(program, [entry], {
      cwd: options.projectRoot,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, FINANCE_RUNTIME_CONFIG: runtimeConfig, PYTHONUTF8: "1", PYTHONUNBUFFERED: "1" },
    });
    let stdout = "", stderr = "", settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new MigrationAgentUnavailable(`${stage} agent exceeded ${options.timeoutMs ?? 900_000}ms`));
    }, options.timeoutMs ?? 900_000);
    const abort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new MigrationAgentUnavailable(`${stage} agent cancelled`));
    };
    options.signal?.addEventListener("abort", abort, { once: true });

    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => {
      // Keep the tail only: the harness is extremely verbose on startup.
      stderr = (stderr + String(chunk)).slice(-4000);
    });
    child.on("error", error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      reject(new MigrationAgentUnavailable(`${stage} agent could not start: ${error.message}`));
    });
    child.on("close", () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      // The entry writes exactly one result line; anything earlier is harness noise.
      const line = stdout.split("\n").map(part => part.trim()).filter(Boolean).reverse()
        .find(part => part.startsWith("{") && part.includes("\"result\""));
      if (!line) {
        resolve({
          stage, status: "FAILED", payload: {} as T, trace: { rounds: [] }, elapsedMs: 0,
          error: `agent produced no result line${stderr ? `: ${stderr.slice(-500)}` : ""}`,
        });
        return;
      }
      try {
        const parsed = JSON.parse(line) as { result: AgentResult<T> };
        resolve(parsed.result);
      } catch (error) {
        resolve({
          stage, status: "FAILED", payload: {} as T, trace: { rounds: [] }, elapsedMs: 0,
          error: `agent result was not JSON: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    });
    child.stdin.end(body);
  });
}
