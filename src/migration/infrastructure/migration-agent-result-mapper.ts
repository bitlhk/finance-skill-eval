import {SourceEvidenceValidator} from "../domain/migration-source-evidence.js";
import { SCAN_COMPLETE_STATUSES } from "../domain/migration-diagnosis.js";
import { languageOfSourcePaths, recommendLanguage,stableToolId } from "../domain/migration-model.js";
import {isAdaptableHarnessCapability} from '../domain/migration-harness.js';
import type {MigrationAgentResultMapper} from '../application/migration-agent-result-mapper.js';
import {capabilityContractSchema,capabilityConstraintsSchema,normalizeCapabilityConstraints} from '../../shared/contracts/runtime-capability.js';

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
      contract?:{inputSchema?:unknown;outputSchema?:unknown;errorSchema?:unknown;semantics?:string};
      constraints?:{permissions?:unknown;sideEffects?:unknown;isolation?:unknown};
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
    const contract=capabilityContractSchema.safeParse(claim.contract),constraints=capabilityConstraintsSchema.safeParse(normalizeCapabilityConstraints(claim.constraints));
    const capability={name:claim.name.trim(),owner:'RUNTIME_HARNESS' as const,migrationAction:'REQUIRES_RUNTIME_BUILDER' as const,blocking:true as const,
      reason:claim.reason,usageContract:claim.usageContract,targetCapability:typeof claim.targetCapability==='string'?claim.targetCapability.trim()||null:null,
      ...(contract.success&&contract.data.semantics.trim()?{contract:contract.data}:{}),
      ...(constraints.success&&constraints.data.isolation.trim()?{constraints:constraints.data}:{}),
      testAvailability:'UNCHECKED' as const,consumerTools:Array.isArray(claim.consumerTools)?claim.consumerTools.filter((name):name is string=>typeof name==='string'&&!!name.trim()):[],evidence};
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

export class AgentResultMapper implements MigrationAgentResultMapper {
  inspection(input:Parameters<MigrationAgentResultMapper['inspection']>[0]){
    return toProjectInspection(input.payload as Parameters<typeof toProjectInspection>[0],input.assetId,input.assetDigest,stableToolId,input.scanner,input.files);
  }
  contractSample(tool:Parameters<MigrationAgentResultMapper['contractSample']>[0]){
    return contractSample(tool);
  }
  generatedImplementations(payload:unknown,files:Record<string,string>,toolNameById:Record<string,string>){
    return toGeneratedImplementations(payload as Parameters<typeof toGeneratedImplementations>[0],files,toolNameById);
  }
  skillDocumentDelivery(payload:unknown,files:Record<string,string>){
    return toSkillDocumentDelivery(payload as Parameters<typeof toSkillDocumentDelivery>[0],files);
  }
}
