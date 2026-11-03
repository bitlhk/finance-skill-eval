import {z} from 'zod';
import type {ImprovementJudgement} from './diagnosis.js';
import type {EffectReviewResult} from './effect-review.js';
import type {AgentCompositionReceipt} from '../../shared/contracts/agent-composition.js';

export const optimizationGoalSchema=z.strictObject({
  goal:z.string().trim().min(1).max(2000).default('提高整体任务效果，结合业务目标权衡改善与回退'),
  maxRounds:z.number().int().min(1).max(5).default(1),
  targetPassRate:z.number().min(0).max(1).default(1),
  maxDurationSeconds:z.number().int().min(60).max(7200).default(1800),
  protectedCaseIds:z.array(z.string().trim().min(1)).refine(ids=>new Set(ids).size===ids.length,'必须通过的案例不能重复').optional(),
});
export type OptimizationGoal=z.infer<typeof optimizationGoalSchema>;
export type CandidateRef={id:string;digest:string};
export type OptimizationEvaluation={id:string;candidate:CandidateRef;protocolDigest:string;criteriaDigest?:string;
  cases:Array<{id:string;passed:boolean|null;observation:unknown}>};
export type OptimizationContextChange={beforeProtocolDigest:string;afterProtocolDigest:string;criteriaDigest:string;reference:string;reason:string};
export type OptimizationWait={kind:'BUILDER'|'CONFIGURATION'|'INPUT';candidate:CandidateRef;reason:string;since:string;remainingMs:number;requestId?:string};
export type AdjustmentResult=CandidateRef|null|{status:'WAITING';kind:OptimizationWait['kind'];candidate:CandidateRef;reason:string};
export type OptimizationRound={number:number;baseline:CandidateRef;stage:'DIAGNOSIS'|'ADJUSTMENT'|'EVALUATION'|'REVIEW'|'SELECTION';
  investigation?:unknown[];
  diagnosis?:ImprovementJudgement;candidate?:CandidateRef;evaluationId?:string;review?:EffectReviewResult;
  selected?:boolean;continued?:boolean;regressedCaseIds?:string[];reason?:string;compositions?:AgentCompositionReceipt[]};
export type OptimizationLoop={id:string;goal:OptimizationGoal;baseline:CandidateRef;best:CandidateRef;bestEvaluationId:string;
  working?:CandidateRef;workingEvaluationId?:string;
  baselineEvaluationId?:string;waiting?:OptimizationWait;contextChanges?:OptimizationContextChange[];
  status:'RUNNING'|'WAITING'|'REVIEW'|'STOPPED'|'FAILED'|'CANCELLED'|'INTERRUPTED';
  stage:OptimizationRound['stage'];rounds:OptimizationRound[];reason?:string;targetReached?:boolean;
  createdAt:string;finishedAt?:string;deadlineAt:string};

export function comparableEvaluations(before:OptimizationEvaluation,after:OptimizationEvaluation,changes:OptimizationContextChange[]=[]){
  const protocols=new Set([before.protocolDigest]);
  if(before.criteriaDigest&&before.criteriaDigest===after.criteriaDigest){
    for(let i=0;i<changes.length;i++)for(const change of changes){
      if(change.criteriaDigest!==before.criteriaDigest)continue;
      if(protocols.has(change.beforeProtocolDigest))protocols.add(change.afterProtocolDigest);
      if(protocols.has(change.afterProtocolDigest))protocols.add(change.beforeProtocolDigest);
    }
  }
  return protocols.has(after.protocolDigest) && before.cases.length>0 && before.cases.length===after.cases.length
    &&new Set(before.cases.map(c=>c.id)).size===before.cases.length&&new Set(after.cases.map(c=>c.id)).size===after.cases.length
    &&before.cases.every(c=>after.cases.some(other=>other.id===c.id))
    &&[...before.cases,...after.cases].every(c=>c.passed!==null);
}
export function regressedCaseIds(before:OptimizationEvaluation,after:OptimizationEvaluation){
  return before.cases.filter(c=>c.passed===true&&after.cases.some(other=>other.id===c.id&&other.passed===false)).map(c=>c.id);
}

/** Ordinary regressions are evidence for the reviewer, not an automatic veto. */
export function selectOptimizationCandidate(before:OptimizationEvaluation,after:OptimizationEvaluation,incumbent:OptimizationEvaluation,
  review:EffectReviewResult,protectedCaseIds:string[]=[],contextChanges:OptimizationContextChange[]=[]){
  const regressions=[...new Set([...regressedCaseIds(before,after),...regressedCaseIds(incumbent,after)])];
  const reject=(reason:string)=>({selected:false,continued:false,regressedCaseIds:regressions,reason});
  if(!comparableEvaluations(before,after,contextChanges)||!comparableEvaluations(incumbent,after,contextChanges))return reject('评测未完成或条件不可比');
  const violations=protectedCaseIds.filter(id=>!after.cases.some(c=>c.id===id&&c.passed===true));
  if(violations.length)return reject(`未满足明确指定的必须通过案例：${violations.join('、')}`);
  if(review.status==='ABSTAINED')return reject(review.reason);
  const result=review.review,selected=result.recommendation==='KEEP_CANDIDATE',continued=result.recommendation==='CONTINUE_CANDIDATE';
  if(!selected&&!continued)return reject(result.reason);
  if(!result.evidenceIds.length||result.evidenceIds.some(id=>!after.cases.some(c=>c.id===id)))return reject('审查缺少有效证据引用');
  if(regressions.length&&(!result.tradeoff?.trim()||!result.regressions.length))return reject('审查需说明回退及其与优化目标之间的取舍');
  if(continued&&!result.nextFocus?.some(focus=>focus.trim()))return reject('继续修复需要明确下一轮修复方向');
  return {selected,continued,regressedCaseIds:regressions,reason:result.reason};
}
