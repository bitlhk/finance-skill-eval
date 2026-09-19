import { createHash } from 'node:crypto';

export type FindingSeverity='ERROR'|'WARNING'|'INFO';
export type SkillFinding={code:string;severity:FindingSeverity;path:string;line:number;message:string;suggestion:string};
export type SkillInspection={status:'COMPLIANT'|'NON_COMPLIANT'|'UNKNOWN';findings:SkillFinding[]};
export type ToolPortability='PORTABLE_MCP'|'PORTABLE_SCRIPT'|'RUNTIME_BOUND'|'INCOMPLETE'|'UNSUPPORTED'|'UNKNOWN';
export type ToolAction='MIGRATE_TO_MCP'|'MIGRATE_TO_SCRIPT';
export type ToolFinding={code:string;severity:FindingSeverity;path:string;line:number;message:string};
export type InspectionEvidence={path:string;line:number;kind:string;detail:string};
export type ToolInspection={
  toolId:string;name:string;sourcePaths:string[];language:string|null;
  kind:'MCP'|'SCRIPT'|'RUNTIME_BOUND'|'UNKNOWN';portability:ToolPortability;
  inputSchema:unknown|null;outputSchema:unknown|null;evidence:InspectionEvidence[];findings:ToolFinding[];
  recommendedAction:ToolAction;entrypoint?:{kind:'PYTHON'|'NODE'|'MCP_HTTP';path?:string;endpoint?:string};
};
export type ProjectInspection={assetId:string;assetDigest:string;inspectedAt:string;skill:SkillInspection;tools:ToolInspection[];scriptsExecuted:false};
export type ToolDecision={toolId:string;action:ToolAction;targetLanguage?:string;reason:string;baseAssetId:string;decidedAt:string};
export type MigrationPlanItem={toolId:string;toolName:string;action:ToolAction;generator:'SHARED_JAVA_MCP'|'PYTHON_SCRIPT';blockingReasons:string[]};
export type MigrationPlan={baseAssetId:string;items:MigrationPlanItem[];generationAllowed:boolean;technicalValidationAllowed:boolean};
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
    const supported=decision&&['MIGRATE_TO_MCP','MIGRATE_TO_SCRIPT'].includes(decision.action);
    const action=supported?decision.action:tool.recommendedAction;
    const blockingReasons:string[]=[];
    if(!supported)blockingReasons.push('请重新选择 MCP 或 Python 脚本');
    return {toolId:tool.toolId,toolName:tool.name,action,
      generator:action==='MIGRATE_TO_MCP'?'SHARED_JAVA_MCP':'PYTHON_SCRIPT',blockingReasons} as MigrationPlanItem;
  });
  const allDecided=inspection.tools.every(t=>current.some(d=>d.toolId===t.toolId&&['MIGRATE_TO_MCP','MIGRATE_TO_SCRIPT'].includes(d.action)));
  return {baseAssetId,items,generationAllowed:allDecided,
    technicalValidationAllowed:false};
}
