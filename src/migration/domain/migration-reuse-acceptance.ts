import {z} from 'zod';
import {simpleMigrationCaseSchema} from './simple-migration-suite.js';
import type {MigrationProject} from './migration-project.js';
import {currentReuseProposal} from './migration-reuse-design.js';
import type {ReuseAcceptanceFailure,ReuseAcceptancePhase} from './migration-reuse-failure.js';

const id=z.string().trim().min(1).max(100);
export const reuseRuntimeSelectionSchema=z.strictObject({environmentId:z.string().min(1),modelId:z.string().min(1)});
/** General execution topology, not a menu of business migration strategies.
 * Each group creates fresh Runtime instances; cases are isolated; turns share one native session. */
export const reuseAcceptancePlanSchema=z.strictObject({
  name:z.string().trim().min(1).max(200),
  groups:z.array(z.strictObject({id,runtime:reuseRuntimeSelectionSchema.optional(),cases:z.array(simpleMigrationCaseSchema).min(1).max(8)})).min(1).max(4),
  checks:z.array(z.strictObject({checkId:id,caseIds:z.array(id).min(1).max(32),criteria:z.array(z.string().trim().min(1).max(2000)).min(1).max(20)})).min(1).max(32),
  unresolvedQuestions:z.array(z.string().trim().min(1).max(2000)).max(32),
});
export type ReuseAcceptanceExecutionPlan=z.infer<typeof reuseAcceptancePlanSchema>;
export const coverageSchema=z.strictObject({status:z.enum(['COVERED','INCOMPLETE']),reasons:z.array(z.string().min(1)).max(64)});
export const reuseAcceptanceVerdictsSchema=z.strictObject({checks:z.array(z.strictObject({checkId:z.string().min(1),
  status:z.enum(['PASSED','FAILED','INDETERMINATE']),reason:z.string().min(1),caseIds:z.array(z.string().min(1)).min(1)})).min(1).max(32)});
export type ReuseAcceptanceRuntimeBinding={environmentId:string;launcherId:string;environmentDigest:string;capabilitiesDigest:string;modelId:string;
  endpointDigest?:string;deploymentId?:string;deliveryDigest?:string};
export type ReuseAcceptanceBinding=ReuseAcceptanceRuntimeBinding&{proposalId:string;proposalDigest:string;candidateDigest:string;inspectionDigest:string;configurationDigest:string;
  additionalRuntimes?:ReuseAcceptanceRuntimeBinding[]};
export type ReuseAcceptancePlan={planId:string;createdAt:string;approvedAt?:string;inputDigest:string;binding:ReuseAcceptanceBinding;plan:ReuseAcceptanceExecutionPlan;
  coverage:{status:'COVERED'|'INCOMPLETE';reasons:string[]}};
export type ReuseAcceptanceResult={taskId:string;planId:string;planDigest:string;binding:ReuseAcceptanceBinding;startedAt:string;finishedAt?:string;
  status:'RUNNING'|'PASSED'|'FAILED'|'INDETERMINATE'|'CANCELLED'|'INTERRUPTED';
  jobs:Array<{groupId:string;jobId:string}>;checks:Array<{checkId:string;status:'NOT_RUN'|'PASSED'|'FAILED'|'INDETERMINATE';reason:string;caseIds:string[]}>;
  reason?:string;phase?:ReuseAcceptancePhase;failure?:ReuseAcceptanceFailure};
export type ReuseAcceptanceSummary={plan:ReuseAcceptancePlan|null;current:boolean;status:ReuseAcceptanceResult['status']|'STALE'|'NOT_RUN';result:ReuseAcceptanceResult|null};

export function reuseAcceptancePlanIssues(project:MigrationProject,plan:ReuseAcceptanceExecutionPlan){
  const proposal=currentReuseProposal(project),issues:string[]=[];
  const expected=proposal?.design.acceptanceChecks.map(c=>c.id)??[];
  if(!proposal?.approvedAt)issues.push('请先确认有效的迁移方案');
  issues.push(...reuseAcceptanceReferenceIssues(plan,expected),...plan.unresolvedQuestions);
  return issues;
}

/** Structural references only. Does not decide coverage or relax unresolved requirements. */
export function reuseAcceptanceReferenceIssues(plan:ReuseAcceptanceExecutionPlan,expected:string[]){
  const issues:string[]=[],ids=plan.groups.flatMap(group=>group.cases.map(c=>c.id));
  if(new Set(ids).size!==ids.length||new Set(plan.groups.map(g=>g.id)).size!==plan.groups.length)issues.push('运行组和案例标识不能重复');
  if(plan.checks.length!==expected.length||new Set(plan.checks.map(c=>c.checkId)).size!==expected.length||plan.checks.some(c=>!expected.includes(c.checkId)))issues.push('验收计划必须逐项覆盖已确认的复用要求');
  for(const check of plan.checks)if(new Set(check.caseIds).size!==check.caseIds.length||check.caseIds.some(c=>!ids.includes(c)))issues.push(`${check.checkId} 引用了不存在或重复的案例`);
  if(ids.some(caseId=>!plan.checks.some(check=>check.caseIds.includes(caseId))))issues.push('每个执行案例都应属于明确验收要求');
  return issues;
}
