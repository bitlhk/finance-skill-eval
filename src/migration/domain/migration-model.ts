import { createHash } from 'node:crypto';

export type FindingSeverity='ERROR'|'WARNING'|'INFO';
export type SkillFinding={code:string;severity:FindingSeverity;path:string;line:number;message:string;suggestion:string};
export type SkillInspection={status:'COMPLIANT'|'NON_COMPLIANT'|'UNKNOWN';findings:SkillFinding[]};
export type ToolPortability='PORTABLE_MCP'|'PORTABLE_SCRIPT'|'RUNTIME_BOUND'|'INCOMPLETE'|'UNSUPPORTED'|'UNKNOWN';
// The human picks the form (an authorization-adjacent choice). The language is a
// technical call: the platform recommends it, the human may override it.
export type ToolForm='MCP'|'SCRIPT';
export type ToolFinding={code:string;severity:FindingSeverity;path:string;line:number;message:string};
export type InspectionEvidence={path:string;line:number;kind:string;detail:string};
/** A concrete input/output instance the analysis read out of the package. Used as test data:
 * a synthesized sample would be testing against a world nobody wrote. */
export type ToolSample={input:unknown;output?:unknown;path:string;line:number};
export type ToolInspection={
  toolId:string;name:string;sourcePaths:string[];language:string|null;
  kind:'MCP'|'SCRIPT'|'RUNTIME_BOUND'|'UNKNOWN';portability:ToolPortability;
  inputSchema:unknown|null;outputSchema:unknown|null;samples:ToolSample[];evidence:InspectionEvidence[];findings:ToolFinding[];
  recommendedForm:ToolForm;recommendedLanguage:string;recommendationReason:string;entrypoint?:{kind:'PYTHON'|'NODE';path:string};
  scriptInjectionEvidence?:InspectionEvidence[];
};
export type ProjectInspection={assetId:string;assetDigest:string;inspectedAt:string;skill:SkillInspection;tools:ToolInspection[];scriptsExecuted:false;
  runtimeCapabilities?:RuntimeHarnessCapability[];
  dependencyAnalysis?:import('./migration-dependency.js').DependencyAnalysis;
  staticAnalysis?:{status:'COMPLETE'|'PARTIAL'|'UNAVAILABLE';dependencyStatus:'EXPLICIT_BINDING'|'NO_BINDING_IN_CHECKED_SCOPE'|'UNKNOWN';scannerDigest:string|null;
    incompleteFiles:Array<{path:string;status:string}>;toolIncompleteFiles?:Array<{path:string;status:string}>};
  runtimeAnalysis?:{status:'RUNNING'|'COMPLETE'|'NOT_CONFIGURED'|'FAILED';model?:string;acceptedBindings:number;rejectedBindings:number;inputTruncated?:boolean}};
export type ToolDecision={toolId:string;form:ToolForm;language?:string;reason:string;baseAssetId:string;decidedAt:string};
/** A source-Runtime capability that must be fulfilled by an external Runtime Builder. */
export type RuntimeHarnessCapability={name:string;owner:'RUNTIME_HARNESS';migrationAction:'REQUIRES_RUNTIME_BUILDER';blocking:true;
  reason:string;usageContract:string;targetCapability:string|null;testAvailability:'UNCHECKED';
  consumerTools:string[];evidence:InspectionEvidence[]};
export type MigrationPlanItem={toolId:string;toolName:string;form:ToolForm;language:string;generator:string;blockingReasons:string[];warnings:string[]};
export type MigrationPlan={baseAssetId:string;items:MigrationPlanItem[];skillMigrationItems:string[];skillBlockingReasons:string[];generationAllowed:boolean;technicalValidationAllowed:boolean};
export type TechnicalValidation={
  runtimeConfigurationDigest?:string;
  inputSource?:'USER'|'SOURCE_SAMPLE'|'SCHEMA_DEFAULT'|'EMPTY';
  inputFields?:string[];
  validationId:string;toolId:string;assetId:string;assetDigest:string;implementationDigest:string;
  casesDigest:string;
  mode:'LOCAL_TRUSTED'|'MCP_HTTP';status:'PASSED'|'FAILED';startedAt:string;finishedAt:string;
  stages:Array<{name:string;passed:boolean;message:string}>;error:string|null;
};

export function stableToolId(name:string,paths:string[]){
  const slug=name.toLowerCase().replace(/[^a-z0-9]+/gu,'-').replace(/^-|-$/gu,'').slice(0,48)||'tool';
  return `${slug}-${createHash('sha256').update(JSON.stringify([name,[...paths].sort()])).digest('hex').slice(0,8)}`;
}

export type TargetLanguage='java'|'python'|'node';

// What the platform can generate. Keep these beside the generators they describe: the
// skill package states the principle, this states the capability, so template changes
// do not leave the documentation lying.
export const MCP_TARGETS=['java','python','node'] as const satisfies readonly TargetLanguage[];
export const SCRIPT_TARGETS=['python','node'] as const satisfies readonly TargetLanguage[];

// The one place the display spelling and the canonical id meet, in both directions: a
// source language arrives as "Java", a plan carries "java", and they are the same
// language. Anything outside this map is one the platform cannot migrate.
const LANGUAGE_IDS:Record<string,TargetLanguage>={java:'java',python:'python',javascript:'node',node:'node'};

// A file's language is a fact about the file, not a model's claim. Both the rules path
// and the agent path read it here, so an inspection cannot disagree with itself.
const EXTENSION_LANGUAGES:ReadonlyArray<readonly [RegExp,string]>=[
  [/\.py$/iu,'Python'],[/\.java$/iu,'Java'],[/[.](?:js|mjs|cjs|ts)$/iu,'JavaScript'],[/\.go$/iu,'Go'],[/\.rs$/iu,'Rust'],
];

export const languageOfSourcePaths=(paths:string[]):string|null=>
  [...new Set(paths.map(path=>EXTENSION_LANGUAGES.find(([pattern])=>pattern.test(path))?.[1])
    .filter((name):name is string=>name!==undefined))].join(', ')||null;

export const canonicalLanguage=(language:string|null|undefined):TargetLanguage|null=>
  LANGUAGE_IDS[(language??'').trim().toLowerCase()]??null;

/** Source languages this evidence names that the platform cannot migrate. */
export const unmigratableLanguages=(language:string|null|undefined):string[]=>
  (language??'').split(',').map(part=>part.trim()).filter(part=>part&&!canonicalLanguage(part));

/**
 * Same language where possible: a cross-language rewrite is the highest-risk thing this
 * platform does, so a source that is already a target wins outright. The "closest
 * ecosystem" step has no model behind it yet, so a source that is not itself a target
 * falls straight to the default -- which differs by form, because the two forms do not
 * ship the same runtimes.
 */
export function recommendLanguage(form:ToolForm,sourceLanguage:string|null|undefined):TargetLanguage{
  const targets:readonly TargetLanguage[]=form==='MCP'?MCP_TARGETS:SCRIPT_TARGETS;
  const same=targets.find(target=>(sourceLanguage??'').split(',').some(part=>canonicalLanguage(part)===target));
  return same??(form==='MCP'?'java':'python');
}

/** The command contract already runs scripts with cwd set to the Runtime workspace. */
export function supportsImplicitScriptContext(dependency:{binding:{kind:string;name:string}|null;sensitive:boolean}){
  return !dependency.sensitive&&dependency.binding?.kind==='SCRIPT_CONTEXT'&&/^(?:workspace|cwd)$/iu.test(dependency.binding.name);
}

export function buildMigrationPlan(inspection:ProjectInspection,decisions:ToolDecision[],baseAssetId:string):MigrationPlan{
  const current=decisions.filter(d=>d.baseAssetId===baseAssetId);
  const items=inspection.tools.map(tool=>{
    const decision=current.find(d=>d.toolId===tool.toolId);
    const supported=!!decision&&['MCP','SCRIPT'].includes(decision.form);
    const form=supported?decision!.form:tool.recommendedForm;
    // Kept for display; the implementation language is derived from the effective form,
    // so a human who switches form without naming a language does not carry the other
    // form's language into the plan.
    const language=(supported?decision!.language:undefined)||recommendLanguage(form,tool.language);
    const blockingReasons:string[]=[],warnings:string[]=[];
    if(form==='MCP'&&inspection.dependencyAnalysis?.dependencies.some(d=>d.toolIds.includes(tool.toolId)&&d.owner==='RUNTIME'&&d.action==='INJECT'&&d.binding?.kind!=='HTTP_HEADER'&&d.binding?.kind!=='SERVICE_ENV'))blockingReasons.push('系统尚未确定运行依赖的传递方式，请返回诊断并重新分析迁移方案');
    if(!supported)blockingReasons.push('请重新选择 MCP 或 Python 脚本');
    const targets:readonly string[]=form==='MCP'?MCP_TARGETS:SCRIPT_TARGETS;
    if(!targets.includes(language))blockingReasons.push(`${form} 不支持实现语言 ${language}，请选择 ${targets.join('、')}`);
    const unmigratable=unmigratableLanguages(tool.language);
    if(unmigratable.length)blockingReasons.push(`源实现是 ${unmigratable.join('、')}，不在平台支持的迁移范围内，需要人工处理`);
    // The human may override the platform's form. When that forces a language the source
    // is not written in, the work is a rewrite rather than a migration -- allowed, but
    // not something to hand over unremarked.
    const target=canonicalLanguage(language);
    if(!unmigratable.length&&target&&!(tool.language??'').split(',').some(part=>canonicalLanguage(part)===target))
      warnings.push(`源实现是 ${tool.language}，将改写为 ${language}；跨语言重写会损失保真度，不推荐`);
    if(form==='SCRIPT'&&inspection.dependencyAnalysis?.dependencies.some(d=>d.toolIds.includes(tool.toolId)&&d.owner==='RUNTIME'&&d.action==='INJECT'&&!supportsImplicitScriptContext(d)))blockingReasons.push('Script 不支持 Runtime 上下文或鉴权注入，请选择 MCP');
    return {toolId:tool.toolId,toolName:tool.name,form,language,
      generator:form==='MCP'?'MCP_SERVICE':'COMMAND_SCRIPT',blockingReasons,warnings} as MigrationPlanItem;
  });
  // Skill-spec findings describe what the migration must repair. They are not a
  // reason to reject the source package: the generated candidate is validated again.
  const skillMigrationItems=inspection.skill.findings.map(finding=>`${finding.code}: ${finding.message}`);
  const skillBlockingReasons:string[]=[];
  const diagnostic=inspection.dependencyAnalysis;
  if(diagnostic&&diagnostic.status!=='COMPLETE')skillBlockingReasons.push('诊断链路或关键依赖尚未确认，请补齐后继续分析');
  return {baseAssetId,items,skillMigrationItems,skillBlockingReasons,
    generationAllowed:skillBlockingReasons.length===0&&items.every(item=>item.blockingReasons.length===0),technicalValidationAllowed:false};
}
