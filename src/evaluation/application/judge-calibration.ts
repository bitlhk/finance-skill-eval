import {calibrationSummary,type HumanReview,type ReviewTarget} from '../domain/human-review.js';
export type CalibrationEvaluation={id:string;label:string;judgeIdentity:string;compatible:boolean;reason?:string;targets:ReviewTarget[]};

/** Align semantic identities, never array positions, and retain missing decisions in coverage. */
export function calibrateJudges(base:ReviewTarget[],records:HumanReview[],evaluations:CalibrationEvaluation[]){
  const key=(target:ReviewTarget)=>JSON.stringify([target.caseId,target.scope,target.label]);
  return evaluations.map(evaluation=>{
    const ambiguous=base.some(t=>base.filter(other=>key(other)===key(t)).length!==1)
      ||evaluation.targets.some(t=>evaluation.targets.filter(other=>key(other)===key(t)).length!==1);
    const compatible=evaluation.compatible&&!ambiguous;
    const aligned=base.map(target=>{
      const match=evaluation.targets.find(other=>key(other)===key(target));
      return {...target,machine:match&&JSON.stringify(match.outcomes)===JSON.stringify(target.outcomes)?match.machine:null};
    });
    return {id:evaluation.id,label:evaluation.label,judgeIdentity:evaluation.judgeIdentity,compatible,
      reason:ambiguous?'判定项标识重复，不能可靠匹配':evaluation.reason,
      summary:compatible?calibrationSummary(aligned,records):[],
      missingTargets:base.filter(t=>!evaluation.targets.some(other=>key(other)===key(t))).length,
      additionalTargets:evaluation.targets.filter(t=>!base.some(other=>key(other)===key(t))).length};
  });
}
