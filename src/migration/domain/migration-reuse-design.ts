import {z} from 'zod';
import {canonicalSha256} from '../../shared/json-canonicalization.js';
import {SourceEvidenceValidator,sourceEvidencePath} from './migration-source-evidence.js';
import type {ProjectInspection,ToolDecision} from './migration-model.js';
import type {MigrationProject} from './migration-project.js';
import {buildMigrationPlan} from './migration-model.js';
import {reuseExecutionContract} from './migration-reuse-execution-contract.js';

const text=z.string().trim().min(1);
const evidence=z.object({path:text,snippet:text});
/** Solutions are model-authored prose. Only references and lifecycle have fixed shapes. */
export const reuseDesignSchema=z.object({
  scope:text,
  preservedBehavior:z.array(text).min(1),
  sourceCouplings:z.array(z.object({description:text,evidence:z.array(evidence).min(1)})),
  changes:z.array(z.object({id:text,title:text,implementation:text,toolNames:z.array(text),evidence:z.array(evidence).min(1)})).min(1),
  dependencies:z.array(z.object({key:text,name:text,contract:text,configuration:text})),
  conditions:z.array(text).min(1),
  unresolvedQuestions:z.array(text),
  acceptanceChecks:z.array(z.object({id:text,purpose:text,requirement:text.optional(),procedure:text,expectedResult:text})).min(1),
});
export type ReuseDesign=z.infer<typeof reuseDesignSchema>;
export type MigrationReuseProposal={proposalId:string;inputDigest:string;sourceDigest:string;createdAt:string;design:ReuseDesign;approvedAt?:string;
  clarification?:string;
  previousProposalId?:string;
  previousDesign?:ReuseDesign;
  telemetry?:import('./migration-reuse-telemetry.js').ReusePlannerTelemetry};
export const reuseReviewSchema=z.object({
  changes:z.array(z.object({changeId:text,status:z.enum(['CONFORMING','NEEDS_CHANGES','UNKNOWN']),reason:text,evidence:z.array(evidence)})),
  unexpectedDependencies:z.array(text),
  semanticIssues:z.array(text),
});
export type ReuseReview=z.infer<typeof reuseReviewSchema>;
export type ReuseConformance={proposalId:string;candidateDigest:string;reviewedAt:string;review:ReuseReview;acceptanceChecks:Array<{checkId:string;status:'NOT_RUN'}>;
  telemetry?:import('./migration-reuse-telemetry.js').ReusePlannerTelemetry};

export function reuseInputDigest(inspection:ProjectInspection,decisions:ToolDecision[],sourceDigest:string){
  const {inspectedAt:_,reuseConformance:__,...facts}=inspection;
  return canonicalSha256({sourceDigest,facts,executionContract:reuseExecutionContract,decisions:decisions.filter(item=>item.baseAssetId===inspection.assetId)
    .map(({toolId,form,language})=>({toolId,form,language})).sort((a,b)=>a.toolId.localeCompare(b.toolId))});
}

export function currentReuseProposal(project:MigrationProject){
  const inspection=project.sourceInspection??project.inspection,proposal=project.reuseProposal;
  if(!inspection||!proposal||proposal.sourceDigest!==project.source.artifactSha256)return null;
  // Carried candidate choices retain source identities; compare against the frozen source facts.
  const currentAsset=project.candidate??project.source;
  const decisions=(project.decisions??[]).filter(item=>item.baseAssetId===currentAsset.assetId)
    .map(item=>({...item,baseAssetId:inspection.assetId}));
  return proposal.inputDigest===reuseInputDigest(inspection,decisions,project.source.artifactSha256)?proposal:null;
}

export function projectMigrationPlan(project:MigrationProject){
  if(!project.inspection)return null;
  const plan=buildMigrationPlan(project.inspection,project.decisions??[],project.inspection.assetId);
  plan.reuseProposal=currentReuseProposal(project);
  if(!plan.reuseProposal?.approvedAt){
    plan.skillBlockingReasons.push(plan.reuseProposal?'请确认可复用迁移方案后生成':'请生成并确认可复用迁移方案');
    plan.generationAllowed=false;
  }
  return plan;
}

export function evidenceIssues(claims:Array<{path:string;snippet:string}>,files:Record<string,string>){
  const validator=new SourceEvidenceValidator(files);
  for(const claim of claims){const resolved=sourceEvidencePath(claim.path,files);if(resolved)claim.path=resolved;}
  return claims.filter(claim=>!validator.find(claim.path,claim.snippet)).map(claim=>
    `源码依据无法定位：${claim.path}（${validator.text(claim.path)===undefined?'文件不存在或路径不唯一':'snippet 不是文件中的连续原文，请逐字引用'}）`);
}

export function reuseDesignIssues(design:ReuseDesign,inspection:ProjectInspection,files:Record<string,string>){
  const issues=evidenceIssues([...design.sourceCouplings,...design.changes].flatMap(item=>item.evidence),files);
  const toolNames=new Set(inspection.tools.map(tool=>tool.name));
  for(const change of design.changes)if(change.toolNames.some(name=>!toolNames.has(name)))issues.push(`改造项 ${change.id} 引用了未识别的工具`);
  for(const values of [design.changes.map(item=>item.id),design.acceptanceChecks.map(item=>item.id),design.dependencies.map(item=>item.key)])
    if(new Set(values).size!==values.length)issues.push('方案中的改造、依赖或验收标识重复');
  for(const dependency of inspection.dependencyAnalysis?.dependencies??[]){
    if(dependency.action==='MOVE_TO_RUNTIME')continue;
    if(dependency.owner==='RUNTIME'&&dependency.action==='INJECT'&&!design.dependencies.some(item=>item.key===dependency.key))
      issues.push(`方案遗漏运行依赖：${dependency.name}`);
  }
  return issues;
}

export function reuseReviewIssues(review:ReuseReview,design:ReuseDesign,files:Record<string,string>){
  const issues=[...review.unexpectedDependencies,...review.semanticIssues];
  const ids=new Set(design.changes.map(item=>item.id));
  if(review.changes.length!==ids.size||new Set(review.changes.map(item=>item.changeId)).size!==ids.size
    ||review.changes.some(item=>!ids.has(item.changeId)))issues.push('候选审查未逐项覆盖已确认的改造方案');
  for(const change of review.changes){
    if(change.status!=='CONFORMING')issues.push(`${change.changeId}：${change.reason}`);
    if(change.status==='CONFORMING'&&!change.evidence.length)issues.push(`${change.changeId} 缺少产物依据`);
    issues.push(...evidenceIssues(change.evidence,files));
  }
  return issues;
}
