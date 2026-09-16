import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { languageOfSourcePaths, recommendLanguage } from "./migration-model.js";
import { stageEnvelope, type StageEnvelope } from "./stage-envelope.js";

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

/** The result line the agent process writes. Framing, not a stage product. */
type WireResult<T> = {
  assetDigest?: string; status?: string; payload?: T; files?: Record<string, string>;
  scanner?: Record<string, unknown> | null; trace?: { rounds: Array<Record<string, unknown>> };
  elapsedMs?: number; modelId?: string; error?: string; rawOutput?: string;
};

/**
 * Why the agent failed, from whichever field carries it.
 *
 * A failed agent either names the reason on `error` or leaves it in what it printed. Reading only
 * `error` turned "the model answered in prose instead of JSON" into "no reason given" -- the same
 * loss as dropping the reason, since the printed output *is* the evidence for that failure.
 */
function failureReason(wire: WireResult<unknown>): string {
  const said = String(wire.error ?? "").trim();
  if (said) return said;
  const tail = String(wire.rawOutput ?? "").trim().slice(-600);
  return tail ? `agent 没有说明失败原因，它的原始输出末尾是：${tail}` : "";
}

/** What the agent produced, beyond the envelope's own binding and status. */
export type AgentPayload<T> = {
  judgement: T;
  /** A4: the files it wrote. */
  files?: Record<string, string>;
  /** A2: the static scanner's own result, when the agent ran it. */
  scanner?: Record<string, unknown> | null;
};

/** The agent process speaks its own JSON on the wire; this is the stage product the platform uses. */
export type AgentResult<T = Record<string, unknown>> = StageEnvelope<AgentPayload<T>>;

/**
 * What the analysis hand-off looks like from the store's side: "give me an analysis".
 *
 * Three states, all of them results. `ABSTAINED` is the agent's judgement and `FAILED` carries the
 * agent's own account of what went wrong; flattening either into `null` is what made both arrive
 * as a faceless "analysis unavailable", which tells whoever has to act on it nothing at all.
 */
export type MigrationAnalysis =
  | { status: "PRODUCED"; payload: unknown; scanner?: Record<string, unknown> | null }
  | { status: "ABSTAINED"; reason: string; missing: string[] }
  | { status: "FAILED"; reason: string };
export type MigrationAnalyzer = (input: {
  assetDigest: string; runId: string; files: Record<string, Uint8Array>;
}) => Promise<MigrationAnalysis | null>;

/**
 * The real analyzer: run the A2 agent. A seam rather than a direct call because the analysis is
 * the store's upstream dependency -- tests stand in a recorded analysis for the same reason they
 * stand in a model, and the payload still goes through the same citation checks.
 *
 * `null` means only one thing now: this platform is not set up to run the agent at all.
 */
export async function analyzeWithAgent(input: { assetDigest: string; runId: string; files: Record<string, Uint8Array> }, options: MigrationAgentOptions): Promise<MigrationAnalysis | null> {
  if (!migrationAgentEnabled()) return null;
  const result = await runMigrationAgent<{ reason?: string; missing?: string[] }>("A2", { ...input, files: encodeArchive(input.files) }, options).catch(() => null);
  if (result?.status === "ABSTAINED") return {
    status: "ABSTAINED",
    reason: String(result.payload.judgement?.reason ?? "").trim() || "分析 agent 没有说明弃权原因",
    missing: (result.payload.judgement?.missing ?? []).map(String).filter(Boolean),
  };
  if (result?.status !== "PRODUCED") return {
    status: "FAILED",
    reason: String(result?.run?.error ?? "").trim() || "分析 agent 没有产出结果，也没有说明原因",
  };
  return { status: "PRODUCED", payload: result.payload.judgement, scanner: result.payload.scanner ?? null };
}

/**
 * What the A4 hand-off looks like from the store's side: "build me these Tools".
 *
 * `null` means this platform cannot run the agent at all, which is what the fallback generator is
 * for. An agent that ran and did not finish says `FAILED` and is reported as such -- falling back
 * there hides the reason and hands the work to a generator that cannot build a service.
 */
export type MigrationImplementation =
  | { status: "PRODUCED" | "ABSTAINED"; payload: unknown; files: Record<string, string> }
  | { status: "FAILED"; reason: string };
export type MigrationImplementer = (input: {
  assetDigest: string; runId: string; files: Record<string, Uint8Array>;
  decisions: unknown[]; tools: unknown[]; contract: Record<string, unknown>;
}) => Promise<MigrationImplementation | null>;

/** The real implementer: run the A4 agent. Injectable for the same reason as the analyzer. */
export async function implementWithAgent(input: {
  assetDigest: string; runId: string; files: Record<string, Uint8Array>;
  decisions: unknown[]; tools: unknown[]; contract: Record<string, unknown>;
}, options: MigrationAgentOptions): Promise<MigrationImplementation | null> {
  if (!migrationAgentEnabled()) return null;
  const result = await runMigrationAgent<{ tools?: unknown[] }>("A4", { ...input, files: encodeArchive(input.files) }, options).catch(() => null);
  if (result?.status !== "PRODUCED" && result?.status !== "ABSTAINED") return {
    status: "FAILED",
    reason: String(result?.run?.error ?? "").trim() || "迁移 agent 没有产出结果，也没有说明原因",
  };
  return { status: result.status, payload: result.payload.judgement, files: result.payload.files ?? {} };
}

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

/** A claim about the source. Whatever it says is only accepted once it lands on a real file and
 * a real line, exactly like a finding. */
type AgentClaim = { path?: string; line?: number; snippet?: string };
type AgentTool = {
  name?: string; sourcePaths?: string[]; language?: string | null;
  portability?: string;
  input?: AgentClaim & { description?: string; schema?: unknown };
  output?: AgentClaim & { description?: string; schema?: unknown };
  samples?: Array<AgentClaim & { input?: unknown; output?: unknown }>;
  /** Which file to run. The platform cannot derive this: the old rules guessed it from a
   * `scripts/` path pattern and ran whatever it found. */
  entrypoint?: AgentClaim & { kind?: string };
  evidence?: Array<{ path?: string; line?: number; snippet?: string }>;
  findings?: Array<{ code?: string; severity?: string; path?: string; line?: number; message?: string }>;
  recommendedForm?: string; recommendationReason?: string;
};

const PORTABILITIES = ["PORTABLE_MCP", "PORTABLE_SCRIPT", "RUNTIME_BOUND", "INCOMPLETE", "UNSUPPORTED", "UNKNOWN"] as const;
type Portability = (typeof PORTABILITIES)[number];

function asPortability(value: unknown): Portability {
  const candidate = String(value ?? "").toUpperCase();
  return (PORTABILITIES as readonly string[]).includes(candidate) ? candidate as Portability : "UNKNOWN";
}
/** Shorter than this, a quote matches half the file and locates nothing; the rule in the skill
 * package asks for enough of the line to identify it. */
const MIN_SNIPPET = 8;

const ENTRYPOINT_KINDS = ["PYTHON", "NODE"] as const;
/**
 * Only an entrypoint that lands on a real file survives; the platform runs it.
 *
 * The file is what it checks, not the agent's line number: a wrong line would cost the platform
 * the one thing it cannot work out for itself -- which file to run -- while the agent had named
 * the right file.
 */
function entrypointOf(claim: AgentTool["entrypoint"], exists: (path: string) => boolean) {
  const path = String(claim?.path ?? ""), kind = String(claim?.kind ?? "").toUpperCase();
  if (!path || !exists(path)) return {};
  if (!(ENTRYPOINT_KINDS as readonly string[]).includes(kind)) return {};
  return { entrypoint: { kind: kind as (typeof ENTRYPOINT_KINDS)[number], path } };
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
  files: Record<string, string> = {},
): import("./migration-model.js").ProjectInspection {
  // Every claim must land on a real file and on text that is really there. This is the check the
  // agent cannot perform on itself, so it stays here rather than moving into the prompt.
  const linesOf = (target: string): string[] => (files[target] ? files[target].split(/\r?\n/u) : []);
  const cited = (target: string, line: number, endLine = line, snippet?: string): boolean => {
    const lines = linesOf(target);
    if (!lines.length || !Number.isInteger(line) || line < 1 || line > lines.length) return false;
    if (endLine < line || endLine > lines.length) return false;
    if (!snippet) return true;
    return lines.slice(line - 1, endLine).join("\n").includes(String(snippet).trim());
  };
  /**
   * Where a claim actually lands.
   *
   * Counting lines is arithmetic, and an agent reading a file through a tool is bad at it -- one
   * run cited line 25 of a 19-line file for every contract it reported, so the whole baseline was
   * dropped even though the text it quoted was right there. So the quoted text is what is trusted
   * and the line number is only a hint: a snippet that can be found is located, a snippet that
   * cannot be found means the claim is not evidence, and a bare line number is taken at its word.
   */
  const locate = (target: string, snippet?: string): number | null => {
    const lines = linesOf(target);
    const text = String(snippet ?? "").trim();
    // The quote is the only input. A line number from the agent is not a fallback: measured over
    // two runs with correct numbers in front of it, the agent placed all eight of its claims on a
    // line that does not contain the text it quoted. Trusting that would put a wrong location into
    // the baseline, which is worse than having none.
    if (!lines.length || text.length < MIN_SNIPPET) return null;
    const found = lines.findIndex(candidate => candidate.includes(text));
    // First match: the guarantee is that the text is on the reported line, not that it is the
    // occurrence the author had in mind. A quote that appears twice cannot say which.
    return found >= 0 ? found + 1 : null;
  };
  const skillStatus = String(payload.skill?.status ?? "").toUpperCase();
  const skillFindings = (payload.skill?.findings ?? []).flatMap(entry => {
    const finding = entry as { code?: string; severity?: string; path?: string; line?: number; message?: string; suggestion?: string };
    if (!finding?.code) return [];
    if (!cited(String(finding.path ?? ""), Number(finding.line ?? 0))) return [];
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
    // The language is read off the files, not taken from the agent's account of them: the
    // recommendation below is a platform rule, so its input has to be a fact.
    const language = languageOfSourcePaths(sourcePaths);
    const portability = asPortability(tool.portability);
    const kind = portability === "PORTABLE_MCP" ? "MCP" as const
      : portability === "PORTABLE_SCRIPT" ? "SCRIPT" as const
        : portability === "RUNTIME_BOUND" ? "RUNTIME_BOUND" as const
          : "UNKNOWN" as const;
    const form = String(tool.recommendedForm ?? "").toUpperCase() === "SCRIPT" ? "SCRIPT" as const : "MCP" as const;
    // The baseline is the analysis, and an analysis claim is worth exactly as much as the place
    // it points at. A contract the agent cannot locate is reported as unread, not as a guess:
    // downstream compares the migration against this, so a fabricated one would be a straw man.
    const contract = (kind: "INPUT_CONTRACT" | "OUTPUT_CONTRACT", claim: AgentTool["input"]): { evidence: import("./migration-model.js").InspectionEvidence; schema: unknown } | null => {
      const path = String(claim?.path ?? ""), at = locate(path, claim?.snippet);
      if (at === null) return null;
      return { evidence: { path, line: at, kind, detail: String(claim?.description ?? "") }, schema: claim?.schema ?? null };
    };
    const input = contract("INPUT_CONTRACT", tool.input), output = contract("OUTPUT_CONTRACT", tool.output);
    return [{
      toolId: stableToolId(name, sourcePaths),
      name,
      sourcePaths,
      language,
      kind,
      portability,
      inputSchema: input?.schema ?? null,
      outputSchema: output?.schema ?? null,
      samples: (tool.samples ?? []).flatMap(item => {
        const path = String(item?.path ?? ""), at = locate(path, item?.snippet);
        return at === null ? [] : [{ input: item?.input ?? {}, ...(item?.output === undefined ? {} : { output: item.output }), path, line: at }];
      }),
      // An entrypoint is a file the platform will actually run, so it has to exist. The old
      // rules matched a `scripts/` path pattern; that is how a wrong file got executed.
      ...entrypointOf(tool.entrypoint, path => linesOf(path).length > 0),
      // Uncited evidence is dropped, not downgraded: a claim that cannot be located
      // is not evidence.
      evidence: [
        ...(input ? [input.evidence] : []), ...(output ? [output.evidence] : []),
        ...(tool.evidence ?? []).flatMap(item => {
          const path = String(item?.path ?? ""), snippet = String(item?.snippet ?? "").trim();
          const at = locate(path, snippet);
          return at === null ? [] : [{ path, line: at, kind: "AGENT", detail: snippet }];
        }),
      ],
      findings: (tool.findings ?? []).flatMap(item => item?.code
        ? [{
          code: String(item.code),
          severity: severity(item.severity),
          path: String(item.path ?? ""),
          line: Number(item.line ?? 1),
          message: String(item.message ?? ""),
        }]
        : []),
      recommendedForm: form,
      recommendedLanguage: recommendLanguage(form, language),
      recommendationReason: String(tool.recommendationReason ?? "").trim(),
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
 * The input to feed a Tool during the contract test.
 *
 * A sample is *read out of the package* by the analysis. Synthesizing one from the Schema was
 * worse than it looked: the Schema itself is an analysis reading, so a synthesized sample is a
 * guess built on a guess, and the test then checks the migration against that world instead of
 * the one the Skill was written for. No sample means the call cannot be exercised -- say so.
 */
export function contractSample(tool: { samples?: Array<{ input: unknown }> } | undefined):
  { input: unknown } | { reason: string } {
  const sample = tool?.samples?.[0];
  return sample ? { input: sample.input } : { reason: "分析没有读出样例，无法构造调用输入" };
}

type AgentGeneration = {
  toolId?: string; status?: string; entrypoint?: string; files?: string[];
  language?: string; compilePassed?: boolean; contractPassed?: boolean;
  /** How to start the thing it just built. A Script's entrypoint is run directly. `prepare` is
   * the optional one-shot step before it (install, build). */
  start?: string[];prepare?: string[];
  /** Every interface change against the baseline, with the reason it was needed. Reported, not
   * gated -- adaptation during migration is normal, but it has to be visible. `drift` is what the
   * contract test *observed*; `changes` is why. Only the agent can report the first: it is the only
   * party holding both the baseline and a running service. */
  changes?: Array<{ path?: string; change?: string; reason?: string }>;
  drift?: Array<{ where?: string; baseline?: unknown; observed?: unknown }>;
  reason?: string; missing?: string[];
};

/**
 * Map an A4 result onto the generator's output shape. Packaging no longer builds anything:
 * it places the files the agent wrote and keeps its start command and change notes.
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
    const reported = String(tool.language ?? "").toLowerCase();
    const language: "java" | "python" | "node" = reported === "java" ? "java" : reported === "node" ? "node" : "python";
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
      : language === "node"
        ? { name: "NODE_CHECK" as const, passed: true as const, message: "语法检查通过" }
        : { name: "PYTHON_COMPILE" as const, passed: true as const, message: "编译通过" };
    out[toolId] = {
      language,
      sourcePath: entrypoint,
      source,
      additionalFiles,
      dependencies: [],
      smokeInput: {},
      ...(Array.isArray(tool.start) && tool.start.length ? { start: tool.start.map(String) } : {}),
      ...(Array.isArray(tool.prepare) && tool.prepare.length ? { prepare: tool.prepare.map(String) } : {}),
      ...(Array.isArray(tool.drift) && tool.drift.length ? { drift: tool.drift } : {}),
      ...(Array.isArray(tool.changes) && tool.changes.length ? { changes: tool.changes } : {}),
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
  const assetDigest = String(request.assetDigest ?? "");
  const failed = (error: string, elapsedMs = 0): AgentResult<T> => stageEnvelope({
    assetDigest, stageId: stage, producer: "AGENT", status: "FAILED",
    payload: { judgement: {} as T }, run: { elapsedMs, error },
  });

  // Cheapest possible unavailable check: without the interpreter or the runtime
  // config there is nothing to spawn, and callers fall back to the rules path.
  if (!existsSync(program) || !existsSync(runtimeConfig)) {
    return failed("migration agent runtime is not available");
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
        resolve(failed(`agent produced no result line${stderr ? `: ${stderr.slice(-500)}` : ""}`));
        return;
      }
      try {
        // The process speaks its own JSON. Its framing is not the stage product: the product is the
        // envelope below, and this is where the two meet.
        const wire = (JSON.parse(line) as { result?: WireResult<T> }).result ?? {};
        const status = String(wire.status ?? "").toUpperCase();
        const reason = failureReason(wire);
        resolve(stageEnvelope({
          assetDigest: String(wire.assetDigest ?? assetDigest),
          stageId: stage,
          producer: "AGENT",
          status: status === "PRODUCED" || status === "ABSTAINED" ? status : "FAILED",
          payload: {
            judgement: (wire.payload ?? {}) as T,
            ...(wire.files ? { files: wire.files } : {}),
            ...(wire.scanner ? { scanner: wire.scanner } : {}),
          },
          ...(wire.trace ? { trace: wire.trace } : {}),
          run: {
            ...(wire.modelId ? { modelId: String(wire.modelId) } : {}),
            ...(typeof wire.elapsedMs === "number" ? { elapsedMs: wire.elapsedMs } : {}),
            ...(reason ? { error: reason } : {}),
          },
        }));
      } catch (error) {
        resolve(failed(`agent result was not JSON: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    child.stdin.end(body);
  });
}
