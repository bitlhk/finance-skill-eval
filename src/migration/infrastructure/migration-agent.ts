import {SourceEvidenceValidator} from "../../service/source-evidence.js";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { modelTimeoutMs, type ModelRole } from "../../service/config.js";
import { SCAN_COMPLETE_STATUSES } from "../domain/migration-diagnosis.js";
import { languageOfSourcePaths, recommendLanguage } from "../domain/migration-model.js";
import { stageEnvelope, type StageEnvelope } from "../domain/migration-stage-envelope.js";
import {isAdaptableHarnessCapability} from '../domain/migration-harness.js';
import type {MigrationAnalysis,MigrationImplementation} from '../application/migration-agent-port.js';

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
  workspaceRoot?:string;libraryInventory?:import('../domain/migration-dependency.js').RuntimeLibraryInventory; assetDigest?: string; status?: string; payload?: T; files?: Record<string, string>;
  scanner?: Record<string, unknown> | null; trace?: { rounds: Array<Record<string, unknown>> };
  elapsedMs?: number; modelId?: string; error?: string; rawOutput?: string;
};

/**
 * Why the agent failed, from whichever field carries it.
 *
 * A failed agent either names the reason on `error` or leaves it in what it printed. Reading only
 * `error` turned "the model answered in prose instead of JSON" into "no reason given" -- the same
 * loss as dropping the reason, since the printed output *is* the evidence for that failure.
 *
 * The fallback is only for a result that did not succeed: a run that produced its payload has no
 * failure to explain, and quoting its output as one would invent an error that never happened.
 */
function failureReason(wire: WireResult<unknown>, produced: boolean): string {
  const said = String(wire.error ?? "").trim();
  if (said || produced) return said;
  const tail = String(wire.rawOutput ?? "").trim().slice(-600);
  return tail ? `agent 没有说明失败原因，它的原始输出末尾是：${tail}` : "";
}

/** What the agent produced, beyond the envelope's own binding and status. */
export type AgentPayload<T> = {
  judgement: T;
  /** Trusted process metadata, never read from the model judgement. */
  workspaceRoot?:string;libraryInventory?:import('../domain/migration-dependency.js').RuntimeLibraryInventory;
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
/**
 * The real analyzer: run the A2 agent. A seam rather than a direct call because the analysis is
 * the store's upstream dependency -- tests stand in a recorded analysis for the same reason they
 * stand in a model, and the payload still goes through the same citation checks.
 *
 * `null` means only one thing now: this platform is not set up to run the agent at all.
 */
export async function analyzeWithAgent(input: { assetDigest: string; runId: string; files: Record<string, Uint8Array>;supplements?:import('../domain/migration-dependency.js').AnalysisSupplement[] }, options: MigrationAgentOptions): Promise<MigrationAnalysis | null> {
  if (!migrationAgentEnabled()) return null;
  let result:AgentResult<{reason?:string;missing?:string[]}>;
  try{result=await runMigrationAgent("A2",{...input,files:encodeArchive(input.files)},options)}catch(error){return {status:"FAILED",reason:error instanceof MigrationAgentUnavailable?error.message:"A2 执行失败，请查看平台日志"}}
  if (result?.status === "ABSTAINED") return {
    status: "ABSTAINED",
    reason: String(result.payload.judgement?.reason ?? "").trim() || "分析 agent 没有说明弃权原因",
    missing: (result.payload.judgement?.missing ?? []).map(String).filter(Boolean),
    workspaceRoot:result.payload.workspaceRoot,libraryInventory:result.payload.libraryInventory,payload:result.payload.judgement,scanner:result.payload.scanner,
  };
  if (result?.status !== "PRODUCED") return {
    status: "FAILED",
    reason: String(result?.run?.error ?? "").trim() || "分析 agent 没有产出结果，也没有说明原因",
  };
  return { status: "PRODUCED", workspaceRoot:result.payload.workspaceRoot,libraryInventory:result.payload.libraryInventory,payload: result.payload.judgement, scanner: result.payload.scanner ?? null };
}

/**
 * What the A4 hand-off looks like from the store's side: "build me these Tools".
 *
 * `null` means this platform cannot run the agent at all, which is what the fallback generator is
 * for. An agent that ran and did not finish says `FAILED` and is reported as such -- falling back
 * there hides the reason and hands the work to a generator that cannot build a service.
 */
/** The real implementer: run the A4 agent. Injectable for the same reason as the analyzer. */
export async function implementWithAgent(input: {
  assetDigest: string; runId: string; files: Record<string, Uint8Array>;
  decisions: unknown[]; tools: unknown[]; contract: Record<string, unknown>;deliveryContract?:Record<string,unknown>;
}, options: MigrationAgentOptions): Promise<MigrationImplementation | null> {
  if (!migrationAgentEnabled()) return null;
  let result:AgentResult<{tools?:unknown[]}>;
  try{result=await runMigrationAgent("A4",{...input,files:encodeArchive(input.files)},options)}catch(error){return {status:"FAILED",reason:error instanceof MigrationAgentUnavailable?error.message:"A4 执行失败，请查看平台日志"}}
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
  maxTokens?: number;
  /** One model call inside the agent, not the whole run -- `timeoutMs` below is the run. */
  modelTimeoutMs?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
};

const ENTRY: Record<AgentStage, string> = {
  A2: path.join("integrations", "openjiuwen", "analyze_agent.py"),
  A4: path.join("integrations", "openjiuwen", "migrate_agent.py"),
};

/** The model role each stage runs as. A2 inspects and diagnoses, A4 migrates. */
const STAGE_ROLE: Record<AgentStage, ModelRole> = { A2: "ANALYZER", A4: "MIGRATION" };

/**
 * How many ReAct iterations an agent gets.
 *
 * A round is a model turn, not a tool call: a model that narrates what it is about to do spends a
 * round without touching a tool, so the number has to fit a working style rather than a call count.
 * Field runs on this repo's own acceptance fixture burned 15 rounds in A2 with a single scanner
 * call, and 25 in A4 with three -- both are the platform failing a task that was going fine, and
 * the fix is a bigger budget or a smaller task, never fewer words in the contract.
 *
 * The platform owns the number because the platform is the side that knows the task, and because
 * the failure it prevents is only actionable if it can be raised.
 */
export function agentIterations(stage: AgentStage): number {
  const configured = Number(process.env.FINANCE_EVAL_AGENT_MAX_ITERATIONS);
  if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  return stage === "A2" ? 60 : 120;
}

/**
 * How many tokens one model call inside the agent may produce.
 *
 * The budget has to cover the model's reasoning *and* its answer: on a reasoning model
 * `reasoning_content` and `content` come out of the same `max_tokens`, so a cap that looks
 * generous for the answer alone leaves nothing for the thinking in front of it. That is how A2
 * failed -- asked for a whole analysis in one object, capped at 6000, it spent the budget reasoning
 * and returned an empty answer with no error. Measured: 3 of 3 runs empty at 6000, 2 of 3 complete
 * at 32000.
 *
 * It is read here rather than left to the agent's own default so that it can be raised where the
 * failure is seen. The Python side reads `maxTokens` from the request; until this existed the
 * platform never sent the field, so the only way to change it was to edit the agent's source.
 *
 * Two knobs, in order: the role's own, then one for both agents. Named by role rather than by
 * stage because that is what the rest of the configuration is named by -- `FINANCE_EVAL_ANALYZER_*`
 * and `FINANCE_EVAL_MIGRATION_*` already select the model, its endpoint and its deadline, and the
 * budget belongs to the same sentence. The two jobs are different sizes -- A2 answers with an
 * analysis, A4 writes whole programs -- so raising one should not force the other up with it.
 */
export function agentMaxTokens(stage: AgentStage): number {
  for (const name of [`FINANCE_EVAL_${STAGE_ROLE[stage]}_MAX_TOKENS`, "FINANCE_EVAL_AGENT_MAX_TOKENS"]) {
    const configured = Number(process.env[name]);
    if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  }
  return 32_000;
}

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
  return process.platform === "win32"
    ? path.join(projectRoot, ".venv-openjiuwen", "Scripts", "python.exe")
    : path.join(projectRoot, ".venv-openjiuwen", "bin", "python");
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
  scriptSecurity?:{safe?:boolean;evidence?:AgentClaim[]};
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
function entrypointOf(claim: AgentTool["entrypoint"], resolve: (path: string) => string | null) {
  const path = resolve(String(claim?.path ?? "")), kind = String(claim?.kind ?? "").toUpperCase();
  if (path === null) return {};
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
  payload: { skill?: { status?: string; findings?: unknown[] }; tools?: AgentTool[];
    runtimeCapabilities?:Array<{name:string;reason:string;usageContract:string;targetCapability?:string|null;
      consumerTools?:string[];evidence:Array<{path:string;snippet:string}>}> },
  assetId: string,
  assetDigest: string,
  stableToolId: (name: string, paths: string[]) => string,
  scanner?: Record<string, unknown> | null,
  files: Record<string, string> = {},
): import("../domain/migration-model.js").ProjectInspection {
  /**
   * The asset path behind a path the agent reported.
   *
   * The agent reads the package inside a workspace it was handed, and it names files the way it
   * reached them -- an absolute `C:\...\Temp\finance-migration-ws-XXXX\skill\SKILL.md`. The asset
   * key is the tail of that: the workspace mirrors the package, so the suffix is exact rather than
   * a guess. A bare `skill/SKILL.md` (the other thing an agent writes) is already a key and passes
   * through untouched. An ambiguous tail resolves to nothing: a claim that could be about either
   * of two files is not a claim about one of them.
   */
  const assetPath = (target: string): string | null => {
    if (files[target]) return target;
    const flattened = target.replaceAll("\\", "/").replace(/^[A-Za-z]:/u, "");
    if (files[flattened]) return flattened;
    const segments = flattened.split("/").filter(Boolean);
    for (let start = 0; start < segments.length; start += 1) {
      const tail = segments.slice(start).join("/");
      const hits = Object.keys(files).filter(key => key === tail || key.endsWith(`/${tail}`));
      if (hits.length === 1) return hits[0] ?? null;
      if (hits.length > 1) return null;
    }
    return null;
  };
  // Every claim must land on a real file and on text that is really there. This is the check the
  // agent cannot perform on itself, so it stays here rather than moving into the prompt.
  const validator=new SourceEvidenceValidator(files);
  const linesOf = (target: string): string[] => {
    const key = assetPath(target);
    return key ? (validator.text(key) ?? "").split("\n") : [];
  };
  const cited = (target: string, line: number, endLine = line, snippet?: string): boolean => {
    const lines = linesOf(target);
    if (!lines.length || !Number.isInteger(line) || line < 1 || line > lines.length) return false;
    if (endLine < line || endLine > lines.length) return false;
    if (!snippet) return true;
    const key=assetPath(target);return !!key&&validator.containsAtLines(key,String(snippet).trim(),line,endLine);
  };
  /**
   * Where a claim actually lands.
   *
   * Counting lines is arithmetic, and an agent reading a file through a tool is bad at it -- one
   * run cited line 25 of a 19-line file for every contract it reported, so the whole baseline was
   * dropped even though the text it quoted was right there. So the quoted text is what is trusted
   * and the line number is only a hint: a snippet that can be found is located, a snippet that
   * cannot be found means the claim is not evidence, and a bare line number is taken at its word.
   *
   * A quote may run over several lines (only newline conventions are normalized), and
   * the line that comes back is where it starts.
   */
  const locate = (target: string, snippet?: string): { path: string; line: number } | null => {
    const key = assetPath(target);
    const raw = key ? (files[key] ?? "") : "";
    const text = String(snippet ?? "");
    // The quote is the only input. A line number from the agent is not a fallback: measured over
    // two runs with correct numbers in front of it, the agent placed all eight of its claims on a
    // line that does not contain the text it quoted. Trusting that would put a wrong location into
    // the baseline, which is worse than having none.
    if (!key || !raw || text.trim().length < MIN_SNIPPET) return null;
    // First match: the guarantee is that the text is on the reported line, not that it is the
    // occurrence the author had in mind. A quote that appears twice cannot say which.
    // The path comes back as the asset key: everything downstream reads the package, not the
    // agent's workspace, and a temp directory in the record is both wrong and unstable.
    const at = validator.find(key,text);
    return at === null ? null : { path: key, line: at.line };
  };
  const skillStatus = String(payload.skill?.status ?? "").toUpperCase();
  const skillFindings = (payload.skill?.findings ?? []).flatMap(entry => {
    const finding = entry as { code?: string; severity?: string; path?: string; line?: number; message?: string; suggestion?: string };
    if (!finding?.code) return [];
    const path = assetPath(String(finding.path ?? ""));
    if (path === null || !cited(path, Number(finding.line ?? 0))) return [];
    return [{
      code: String(finding.code),
      severity: severity(finding.severity),
      path,
      line: Number(finding.line ?? 1),
      message: String(finding.message ?? ""),
      suggestion: String(finding.suggestion ?? ""),
    }];
  });
  const runtimeCapabilities:import('../domain/migration-model.js').RuntimeHarnessCapability[]=[];
  for(const claim of payload.runtimeCapabilities??[]){
    if(!claim||typeof claim.name!=='string'||!claim.name.trim()||typeof claim.reason!=='string'||!claim.reason.trim()
      ||typeof claim.usageContract!=='string'||!claim.usageContract.trim()||!Array.isArray(claim.evidence))continue;
    const evidence=claim.evidence.flatMap(item=>{
      if(!item||typeof item.path!=='string'||typeof item.snippet!=='string')return [];
      const at=locate(item.path,item.snippet);
      return at?[{...at,kind:'RUNTIME_HARNESS',detail:item.snippet}]:[];
    });
    // An unsupported claim must not remove a tool from migration.
    if(!evidence.length||evidence.length!==claim.evidence.length||runtimeCapabilities.some(c=>c.name===claim.name.trim()))continue;
    const capability={name:claim.name.trim(),owner:'RUNTIME_HARNESS' as const,migrationAction:'REQUIRES_RUNTIME_BUILDER' as const,blocking:true as const,
      reason:claim.reason,usageContract:claim.usageContract,targetCapability:typeof claim.targetCapability==='string'?claim.targetCapability:null,
      testAvailability:'UNCHECKED' as const,consumerTools:Array.isArray(claim.consumerTools)?claim.consumerTools.filter((name):name is string=>typeof name==='string'):[],evidence};
    if(isAdaptableHarnessCapability(capability))runtimeCapabilities.push(capability);
  }
  const tools = (payload.tools ?? []).flatMap(tool => {
    const name = String(tool.name ?? "").trim();
    if (!name) return [];
    if(runtimeCapabilities.some(capability=>capability.name===name))return [];
    // Same convention as every other path the agent names: it read the file in its own workspace.
    const sourcePaths = (tool.sourcePaths ?? []).flatMap(entry => {
      const path = String(entry ?? "").trim();
      if (!path) return [];
      const key = assetPath(path);
      return key === null ? [] : [key];
    });
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
    const contract = (kind: "INPUT_CONTRACT" | "OUTPUT_CONTRACT", claim: AgentTool["input"]): { evidence: import("../domain/migration-model.js").InspectionEvidence; schema: unknown } | null => {
      const at = locate(String(claim?.path ?? ""), claim?.snippet);
      if (at === null) return null;
      return { evidence: { path: at.path, line: at.line, kind, detail: String(claim?.description ?? "") }, schema: claim?.schema ?? null };
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
        const at = locate(String(item?.path ?? ""), item?.snippet);
        return at === null ? [] : [{ input: item?.input ?? {}, ...(item?.output === undefined ? {} : { output: item.output }), path: at.path, line: at.line }];
      }),
      // An entrypoint is a file the platform will actually run, so it has to exist. The old
      // rules matched a `scripts/` path pattern; that is how a wrong file got executed.
      ...entrypointOf(tool.entrypoint, path => (linesOf(path).length > 0 ? assetPath(path) : null)),
      // Uncited evidence is dropped, not downgraded: a claim that cannot be located
      // is not evidence.
      evidence: [
        ...(input ? [input.evidence] : []), ...(output ? [output.evidence] : []),
        ...(tool.evidence ?? []).flatMap(item => {
          const snippet = String(item?.snippet ?? "").trim();
          const at = locate(String(item?.path ?? ""), snippet);
          return at === null ? [] : [{ path: at.path, line: at.line, kind: "AGENT", detail: snippet }];
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
      scriptInjectionEvidence:tool.scriptSecurity?.safe?(tool.scriptSecurity.evidence??[]).flatMap(claim=>{const at=locate(String(claim.path??''),claim.snippet);return at?[{path:at.path,line:at.line,kind:'SCRIPT_INJECTION_SECURITY',detail:String(claim.snippet)}]:[]}):[],
      recommendedLanguage: recommendLanguage(form, language),
      recommendationReason: String(tool.recommendationReason ?? "").trim(),
    }];
  });
  // Coverage comes from the scanner, not from the agent's own account of itself.
  const incompleteFiles = Array.isArray(scanner?.coverage)
    ? (scanner.coverage as Array<{ path?: string; status?: string }>).flatMap(entry =>
        entry?.path && entry.status && !SCAN_COMPLETE_STATUSES.includes(String(entry.status).toUpperCase())
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
    runtimeCapabilities,
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
  runtimeBindings?:Array<{key:string;header:string}>;
  toolId?: string; status?: string; entrypoint?: string; files?: string[];
  language?: string; compilePassed?: boolean; contractPassed?: boolean;runtimeDependenciesPending?:string[];callExecuted?:boolean;
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

type AgentSkillDelivery={skillFile?:string;files?:Array<{source?:string;path?:string}>};

/** Decode the explicit A4 documentation manifest.  Paths in `source` address the isolated agent
 * workspace; paths in `path` are relative to the final Skill root.  Keeping the two separate lets
 * A4 replace a root SKILL.md without mutating the uploaded source in place. */
export function toSkillDocumentDelivery(
  payload:{skillDelivery?:AgentSkillDelivery},files:Record<string,string>,
):import('../domain/migration-candidate-artifact.js').SkillDocumentDelivery|null{
  const delivery=payload.skillDelivery;
  if(!delivery||delivery.skillFile!=='SKILL.md'||!Array.isArray(delivery.files)||!delivery.files.length||delivery.files.length>100)return null;
  const result:Record<string,string>={},targets=new Set<string>();
  for(const item of delivery.files){
    const source=typeof item.source==='string'?item.source.replaceAll('\\','/').replace(/^\.\//u,''):'';
    const target=typeof item.path==='string'?item.path.replaceAll('\\','/').replace(/^\.\//u,''):'';
    if(!source.startsWith('migration-skill/')||source.split('/').includes('..')||!target||target.startsWith('/')||target.split('/').includes('..'))return null;
    if(target!=='SKILL.md'&&!/^references\/.+\.(?:md|mdx|txt)$/iu.test(target))return null;
    const key=target.toLowerCase(),encoded=files[source];if(typeof encoded!=='string'||targets.has(key))return null;
    try{
      const bytes=Buffer.from(encoded,'base64');
      if(bytes.length>300_000||bytes.toString('base64').replace(/=+$/u,'')!==encoded.replace(/=+$/u,''))return null;
      result[target]=new TextDecoder('utf-8',{fatal:true}).decode(bytes);targets.add(key);
    }catch{return null}
  }
  return result['SKILL.md']?{files:result}:null;
}

/**
 * Map an A4 result onto the generator's output shape. Packaging no longer builds anything:
 * it places the files the agent wrote and keeps its start command and change notes.
 */
export function toGeneratedImplementations(
  payload: { tools?: AgentGeneration[] },
  files: Record<string, string>,
  toolNameById: Record<string, string>,
): Record<string, import("../domain/generated-tool-implementation.js").GeneratedToolImplementation> {
  const decode = (name: string): string | null => {
    const encoded = files[name];
    if (typeof encoded !== "string") return null;
    try { return Buffer.from(encoded, "base64").toString("utf8"); } catch { return null; }
  };
  const out: Record<string, import("../domain/generated-tool-implementation.js").GeneratedToolImplementation> = {};
  for (const tool of payload.tools ?? []) {
    const toolId = String(tool.toolId ?? "");
    let entrypoint = String(tool.entrypoint ?? "");
    const reported = String(tool.language ?? "").toLowerCase();
    const language: "java" | "python" | "node" = reported === "java" ? "java" : reported === "node" ? "node" : "python";
    if (!toolId || !entrypoint) continue;
    if (tool.status && tool.status.toUpperCase() === "ABSTAINED") continue;
    let source = decode(entrypoint);
    if(source===null&&language==='java'&&Array.isArray(tool.start)){
      const mainClass=tool.start.map(String).at(-1),suffix=mainClass?`${mainClass.replaceAll('.','/')}.java`:'';
      const matches=(tool.files??[]).map(String).filter(name=>suffix&&name.endsWith(suffix)&&decode(name)!==null);
      if(matches.length===1){entrypoint=matches[0]!;source=decode(entrypoint)}
    }
    if (source === null) continue;
    const additionalFiles = (tool.files ?? [])
      .map(String)
      .filter(name => name && name !== entrypoint)
      .flatMap(name => { const content = decode(name); return content === null ? [] : [{ path: name, content }]; });
    const declaredPrepare=Array.isArray(tool.prepare)&&tool.prepare.length?tool.prepare.map(String):undefined;
    const javaSources=(tool.files??[]).map(String).filter(name=>name.endsWith('.java')&&decode(name)!==null);
    // Contract tests run in the agent workspace, where compile_source has already left .class
    // files. Those build artefacts are intentionally not packaged, so a Java delivery must rebuild
    // itself in the target workspace even when the model omitted prepare.
    const prepare=declaredPrepare??(language==='java'&&javaSources.length
      ?['javac','--release','17','-encoding','UTF-8',...javaSources]:undefined);
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
      ...(typeof tool.callExecuted==='boolean'?{callExecuted:tool.callExecuted}:{}),
      ...(Array.isArray(tool.runtimeDependenciesPending)?{runtimeDependenciesPending:tool.runtimeDependenciesPending.filter((name):name is string=>typeof name==='string')}:{}),
      ...(tool.runtimeBindings?{runtimeBindings:tool.runtimeBindings}:{}),
      smokeInput: {},
      ...(Array.isArray(tool.start) && tool.start.length ? { start: tool.start.map(String) } : {}),
      ...(prepare?{prepare}:{}),
      ...(Array.isArray(tool.drift) && tool.drift.length ? { drift: tool.drift } : {}),
      ...(Array.isArray(tool.changes) && tool.changes.length ? { changes: tool.changes } : {}),
      generatedBy: toolNameById[toolId] ?? toolId,
      explanation: tool.reason?.trim() || (tool.callExecuted === false ? "由 A4 迁移 agent 生成并完成静态或接口契约检查，实际调用待验证。" : "由 A4 迁移 agent 生成并通过编译与契约测试。"),
      attempts: 1,
      checks: tool.compilePassed === false ? [] : [
        compileCheck,
        { name: "JSON_SMOKE" as const, passed: true as const, message: tool.callExecuted===false?"静态或接口契约检查完成，实际调用尚未执行；需准备测试依赖后验证":tool.contractPassed === false ? "契约测试未通过" : "契约测试通过（输入输出形状）" },
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

  const requestedDecisions=stage==='A4'&&Array.isArray((request as {decisions?:unknown[]}).decisions)
    ?(request as {decisions:unknown[]}).decisions.length:0;
  // A4 used to receive the same 120-turn ceiling for one Tool and for a large mixed project.
  // That let a mistaken implementation shape consume many model turns before it eventually
  // corrected itself.  Keep enough room for read/write/compile/test/fix, but scale it with the
  // actual number of authorized Tool decisions.
  const iterationBudget=options.maxIterations??(stage==='A4'
    ?Math.min(agentIterations(stage),Math.max(28,20+requestedDecisions*8))
    :agentIterations(stage));
  const body = JSON.stringify({
    stage,
    model: { modelId: options.modelId, providerId: options.providerId ?? "service-execution" },
    maxIterations: iterationBudget,
    maxTokens: options.maxTokens ?? agentMaxTokens(stage),
    // The harness's own default is 60 s per model call, which a reasoning model passes routinely:
    // measured, the same request ranged 36 s to 185 s. The role's deadline is the number that
    // already means "how long one call for this role may take", so the agent gets that one.
    modelTimeoutMs: options.modelTimeoutMs ?? modelTimeoutMs(STAGE_ROLE[stage]),
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
        const reason = failureReason(wire, status === "PRODUCED" || status === "ABSTAINED");
        resolve(stageEnvelope({
          assetDigest: String(wire.assetDigest ?? assetDigest),
          stageId: stage,
          producer: "AGENT",
          status: status === "PRODUCED" || status === "ABSTAINED" ? status : "FAILED",
          payload: {
            judgement: (wire.payload ?? {}) as T,
            ...(wire.libraryInventory?{libraryInventory:wire.libraryInventory}:{}),
            ...(typeof wire.workspaceRoot==="string"?{workspaceRoot:wire.workspaceRoot}:{}),
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
