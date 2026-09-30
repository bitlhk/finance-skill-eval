import { strToU8 } from 'fflate';
import type { MigrationAnalyzer, MigrationImplementer } from '../src/migration/application/migration-agent-port.js';
import { stableToolId, type ProjectInspection, type ToolInspection, type ToolPortability } from '../src/migration/domain/migration-model.js';

/**
 * Fixtures for the shape the platform actually receives.
 *
 * Tools and their contracts come from the A2 analysis; there is no rules path that guesses them.
 * So a test either builds an inspection directly (the platform's input) or stands in an analysis
 * payload and lets the real citation checks run. What it must not do is ask a rule to invent a
 * Tool -- that behaviour is gone on purpose.
 */

export const SKILL_FILE = 'skill/SKILL.md';
export const SKILL_MD = [
  '---',
  'name: fixture-skill',
  'description: 夹具 Skill，用来说明分析结果怎样喂进平台。',
  '---',
  '调用 `lookup`，传入 account_id。',
  '成功时返回币种与账面余额。',
].join('\n') + '\n';

/** A Tool as the analysis reports it, citing lines that exist in SKILL_MD. */
export function analyzedTool(input: {
  name: string; sourcePaths?: string[]; portability?: ToolPortability; language?: string | null;
  inputSchema?: unknown; outputSchema?: unknown; sample?: unknown; form?: 'MCP' | 'SCRIPT';
  entrypoint?: { kind: 'PYTHON' | 'NODE'; path: string };
}): Record<string, unknown> {
  const portability = input.portability ?? 'RUNTIME_BOUND';
  const sourcePaths = input.sourcePaths ?? [`tool/${input.name}.py`];
  return {
    name: input.name,
    sourcePaths,
    language: input.language ?? 'Python',
    portability,
    // Quoted, not counted: the platform locates a claim by this text, so the fixture quotes the
    // lines of SKILL_MD that actually say these things.
    input: { description: '传入 account_id', schema: input.inputSchema ?? null, path: SKILL_FILE, snippet: '调用 `lookup`，传入 account_id' },
    output: { description: '返回币种与账面余额', schema: input.outputSchema ?? null, path: SKILL_FILE, snippet: '成功时返回币种与账面余额' },
    ...(input.sample === undefined ? {} : { samples: [{ input: input.sample, path: SKILL_FILE, snippet: '调用 `lookup`，传入 account_id' }] }),
    ...(input.entrypoint ? { entrypoint: input.entrypoint } : {}),
    evidence: [],
    findings: [],
    recommendedForm: input.form ?? (portability === 'PORTABLE_SCRIPT' ? 'SCRIPT' : 'MCP'),
    recommendationReason: '夹具',
  };
}

/** A stand-in A2: it returns an analysis payload, which still goes through the citation checks. */
export function analysisFixture(tools: Array<Record<string, unknown>>, scanner?: Record<string, unknown> | null): MigrationAnalyzer {
  return async input => ({
    status: 'PRODUCED' as const,
    payload: { status: 'PRODUCED', skill: { status: 'COMPLIANT', findings: [] }, tools,
      dependencyAnalysis:{dependencies:[],chains:tools.map(tool=>{const source=(tool.sourcePaths as string[]|undefined)?.find(p=>input.files[p]);const path=source??SKILL_FILE;const text=Buffer.from(input.files[path]??[]).toString('utf8');return {toolName:tool.name,nodes:[{id:'fixture-entry',title:'Fixture business operation',detail:'Recorded test contract',dependencyKeys:[],evidence:[{path,snippet:text.slice(0,200)}]}],edges:[]}})} },
    // Generation is gated on the scanner having run, so a fixture that expects to generate
    // reports a clean coverage by default.
    scanner: scanner === undefined ? { scannerDigest: 'a'.repeat(64), coverage: [] } : scanner,
  });
}

/**
 * A stand-in A4: the agent that writes the code. It returns the files it "wrote" plus how to
 * start them; packaging then places them exactly as it would the real agent's output.
 */
export function implementationFixture(specs: Array<{
  /** Keyed by Tool name: the ids only exist after the analysis, which is what a real run sees too. */
  tool: string; entrypoint: string; files: Record<string, string>;
  language?: string; start?: string[]; prepare?: string[]; status?: string; reason?: string;
  changes?: Array<{ path?: string; change?: string; reason?: string }>;
  drift?: Array<{ where?: string; baseline?: unknown; observed?: unknown }>;
}>): MigrationImplementer {
  return async input => {
    const idByName = Object.fromEntries((input.tools as Array<{ toolId: string; name: string }>).map(item => [item.name, item.toolId]));
    const sourceSkillFile=String((input.deliveryContract as any)?.skillDocumentation?.sourceSkillFile??'SKILL.md');
    const skillRoot=sourceSkillFile.includes('/')?sourceSkillFile.slice(0,sourceSkillFile.lastIndexOf('/')+1):'';
    const documentFiles=Object.entries(input.files).flatMap(([path,content])=>{
      const relative=skillRoot&&path.startsWith(skillRoot)?path.slice(skillRoot.length):path;
      if(path!==sourceSkillFile&&!/^references\/.+\.(?:md|mdx|txt)$/iu.test(relative))return [];
      const target=path===sourceSkillFile?'SKILL.md':relative;
      return [{source:`migration-skill/${target}`,target,content}];
    });
    return {
      status: 'PRODUCED',
      payload: {
        status: 'PRODUCED',
        skillDelivery:{skillFile:'SKILL.md',files:documentFiles.map(file=>({source:file.source,path:file.target}))},
        runtimeToolConfig:(input.deliveryContract as any)?.runtimeToolConfigTemplate.runtimeToolConfig,
        tools: specs.flatMap(spec => {
          const toolId = idByName[spec.tool];
          return toolId ? [{
            toolId, status: spec.status ?? 'PRODUCED', entrypoint: spec.entrypoint,
            files: Object.keys(spec.files), language: spec.language ?? 'python',
            ...(spec.start ? { start: spec.start } : {}), ...(spec.prepare ? { prepare: spec.prepare } : {}),
            ...(spec.changes ? { changes: spec.changes } : {}), ...(spec.drift ? { drift: spec.drift } : {}),
            ...(spec.reason ? { reason: spec.reason } : {}),
            runtimeBindings:((input.contract as any)?.[toolId]?.dependencies??[]).filter((d:any)=>d.owner==='RUNTIME'&&d.action==='INJECT').map((d:any)=>({key:d.key,header:d.binding?.name})),
            compilePassed: true, contractPassed: true,
          }] : [];
        }),
      },
      files: Object.fromEntries([
        ...documentFiles.map(file=>[file.source,Buffer.from(file.content).toString('base64')] as const),
        ...specs.flatMap(spec =>Object.entries(spec.files).map(([path, content]) => [path, Buffer.from(content).toString('base64')] as const)),
      ]),
    };
  };
}

export function toolFixture(input: Partial<ToolInspection> & { name: string; sourcePaths: string[] }): ToolInspection {
  return {
    toolId: stableToolId(input.name, input.sourcePaths),
    language: 'Python', kind: 'RUNTIME_BOUND', portability: 'RUNTIME_BOUND',
    inputSchema: null, outputSchema: null, samples: [], evidence: [], findings: [],
    recommendedForm: 'SCRIPT', recommendedLanguage: 'python', recommendationReason: '夹具',
    ...input,
  };
}

export function inspectionFixture(tools: ToolInspection[], assetId = 'asset'): ProjectInspection {
  return { assetId, assetDigest: 'd'.repeat(64), inspectedAt: new Date().toISOString(), tools,
    skill: { status: 'COMPLIANT', findings: [] }, scriptsExecuted: false };
}

export const archiveOf = (files: Record<string, string>) =>
  Object.fromEntries(Object.entries(files).map(([name, content]) => [name, strToU8(content)]));
