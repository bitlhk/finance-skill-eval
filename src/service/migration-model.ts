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
export type ToolInspection={
  toolId:string;name:string;sourcePaths:string[];language:string|null;
  kind:'MCP'|'SCRIPT'|'RUNTIME_BOUND'|'UNKNOWN';portability:ToolPortability;
  inputSchema:unknown|null;outputSchema:unknown|null;evidence:InspectionEvidence[];findings:ToolFinding[];
  recommendedForm:ToolForm;recommendedLanguage:string;recommendationReason:string;entrypoint?:{kind:'PYTHON'|'NODE'|'MCP_HTTP';path?:string;endpoint?:string};
};
export type ProjectInspection={assetId:string;assetDigest:string;inspectedAt:string;skill:SkillInspection;tools:ToolInspection[];scriptsExecuted:false;
  staticAnalysis?:{status:'COMPLETE'|'PARTIAL'|'UNAVAILABLE';dependencyStatus:'EXPLICIT_BINDING'|'NO_BINDING_IN_CHECKED_SCOPE'|'UNKNOWN';scannerDigest:string|null;
    incompleteFiles:Array<{path:string;status:string}>;toolIncompleteFiles?:Array<{path:string;status:string}>};
  runtimeAnalysis?:{status:'RUNNING'|'COMPLETE'|'NOT_CONFIGURED'|'FAILED';model?:string;acceptedBindings:number;rejectedBindings:number;inputTruncated?:boolean}};
export type ToolDecision={toolId:string;form:ToolForm;language?:string;reason:string;baseAssetId:string;decidedAt:string};
export type MigrationPlanItem={toolId:string;toolName:string;form:ToolForm;language:string;generator:string;blockingReasons:string[]};
export type MigrationPlan={baseAssetId:string;items:MigrationPlanItem[];skillMigrationItems:string[];skillBlockingReasons:string[];generationAllowed:boolean;technicalValidationAllowed:boolean};
export type TechnicalValidation={
  validationId:string;toolId:string;assetId:string;assetDigest:string;implementationDigest:string;
  casesDigest:string;
  mode:'LOCAL_TRUSTED'|'MCP_HTTP';status:'PASSED'|'FAILED';startedAt:string;finishedAt:string;
  stages:Array<{name:string;passed:boolean;message:string}>;error:string|null;
};

export function stableToolId(name:string,paths:string[]){
  const slug=name.toLowerCase().replace(/[^a-z0-9]+/gu,'-').replace(/^-|-$/gu,'').slice(0,48)||'tool';
  return `${slug}-${createHash('sha256').update(JSON.stringify([name,[...paths].sort()])).digest('hex').slice(0,8)}`;
}

export function buildMigrationPlan(inspection:ProjectInspection,decisions:ToolDecision[],baseAssetId:string):MigrationPlan{
  const current=decisions.filter(d=>d.baseAssetId===baseAssetId);
  const items=inspection.tools.map(tool=>{
    const decision=current.find(d=>d.toolId===tool.toolId);
    const supported=!!decision&&['MCP','SCRIPT'].includes(decision.form);
    const form=supported?decision!.form:tool.recommendedForm;
    const language=(supported?decision!.language:undefined)??tool.recommendedLanguage;
    const blockingReasons:string[]=[];
    if(!supported)blockingReasons.push('请重新选择 MCP 或 Python 脚本');
    return {toolId:tool.toolId,toolName:tool.name,form,language,
      generator:form==='MCP'?'MCP_SERVICE':'SCRIPT_TOOL',blockingReasons} as MigrationPlanItem;
  });
  const allDecided=inspection.tools.every(t=>current.some(d=>d.toolId===t.toolId&&['MCP','SCRIPT'].includes(d.form)));
  // Skill-spec findings describe what the migration must repair. They are not a
  // reason to reject the source package: the generated candidate is validated again.
  const skillMigrationItems=inspection.skill.findings.map(finding=>`${finding.code}: ${finding.message}`);
  const skillBlockingReasons:string[]=[];
  return {baseAssetId,items,skillMigrationItems,skillBlockingReasons,generationAllowed:allDecided,
    technicalValidationAllowed:false};
}
