import {canonicalSha256} from '../shared/json-canonicalization.js';
import {comparisonReviewTargets,migrationReviewTargets} from '../evaluation/application/review-targets.js';
import type {CalibrationEvaluation} from '../evaluation/application/judge-calibration.js';
import type {BundleRun,BundleTask} from '../migration/tasks/domain/task-model.js';
import type {EvaluationJob} from '../shared/contracts/evaluation-job.js';
const digest=(value:unknown)=>canonicalSha256(JSON.parse(JSON.stringify(value)));
export function migrationCalibrations(run:BundleRun,records:BundleTask['rescorings']):CalibrationEvaluation[]{
  return (records??[]).filter(record=>record.sourceRunId===run.id).flatMap(record=>(record.attempts??[record]).map((attempt,index)=>{
    const samePlan=!record.plan||(run.phase==='holdout'?(run.suite.holdoutCases??[]):run.suite.cases).every(c=>digest(c.evaluationPlan??null)===digest(record.plan));
    const sameEvidence=attempt.sourceDigest===digest(run)&&attempt.cases.every(c=>{
      const original=run.cases.find(item=>item.id===c.id);
      return original?.evidence&&'evidenceDigest' in c&&c.evidenceDigest===digest(original.evidence);
    });
    return {id:`${record.id}:${index}`,label:`${record.createdAt} · 第 ${index+1} 次`,judgeIdentity:attempt.judgeDigest??'未保存 Judge 身份',
      compatible:samePlan&&Boolean(sameEvidence),reason:!samePlan?'评测方案已变化，不沿用旧标准的人工标注':!sameEvidence?'无法核对原始证据关联':undefined,
      targets:migrationReviewTargets({cases:attempt.cases.map(c=>({...c,passed:c.status==='PASS',unverified:c.status==='UNVERIFIED'}))})};
  }));
}
export function comparisonCalibrations(job:EvaluationJob):CalibrationEvaluation[]{
  const source=job.report!;
  return (job.rescorings??[]).flatMap(record=>(record.attempts??[{cases:record.cases}]).map((attempt,index)=>{
    const compatible=record.sourceReportFingerprint===source.reportFingerprint&&attempt.cases.every(c=>{
      const original=source.cases.find(item=>item.caseId===c.caseId);
      return original&&digest(original.left)===digest(c.left)&&digest(original.right)===digest(c.right);
    });
    return {id:`${record.id}:${index}`,label:`${record.createdAt} · 第 ${index+1} 次`,judgeIdentity:record.judgeConfigurationDigest??record.judgeId,
      compatible,reason:compatible?undefined:'重评与原报告的执行证据不一致',targets:comparisonReviewTargets({...source,cases:attempt.cases})};
  }));
}
