import type {EffectReviewInput} from '../../agents/ports.js';
import {comparableEvaluations,type OptimizationEvaluation} from '../domain/optimization-loop.js';

/** Only development evaluations selected by the scenario adapter reach the independent reviewer. */
export function effectReviewInput(goal:string,before:OptimizationEvaluation,after:OptimizationEvaluation,
  changes:EffectReviewInput['changes'],context:{incumbent?:OptimizationEvaluation;protectedCaseIds?:string[];targetPassRate?:number;remainingRounds?:number;contextChanges?:EffectReviewInput['contextChanges']}={}):EffectReviewInput{
  const incumbent=context.incumbent??before;
  return {goal,baselineDigest:before.candidate.digest,candidateDigest:after.candidate.digest,incumbentDigest:incumbent.candidate.digest,changes,
    protectedCaseIds:context.protectedCaseIds??[],targetPassRate:context.targetPassRate,remainingRounds:context.remainingRounds,
    contextChanges:context.contextChanges,
    evidence:after.cases.map(c=>({evidenceId:c.id,evaluationDigest:after.protocolDigest,
      completed:c.passed!==null,comparable:comparableEvaluations(before,after,context.contextChanges)&&comparableEvaluations(incumbent,after,context.contextChanges),
      summary:JSON.stringify({before:before.cases.find(b=>b.id===c.id)?.passed,after:c.passed,incumbent:incumbent.cases.find(b=>b.id===c.id)?.passed}),
      baseline:before.cases.find(b=>b.id===c.id)?.observation,candidate:c.observation,incumbent:incumbent.cases.find(b=>b.id===c.id)?.observation}))};
}
