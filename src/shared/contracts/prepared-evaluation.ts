import type { EvalCase,EvaluationContextSnapshot } from '../../contracts.js';

export type PreparedEvaluation = {
  schemaVersion:'finance.skill-eval.preparation.v1';
  preparationId:string;
  skillAssetId:string;
  skillId:string;
  skillVersion:string;
  summary:string;
  cases:EvalCase[];
  holdoutCases?:EvalCase[];
  source:'ai_generated'|'manual';
  evaluationContext:EvaluationContextSnapshot|null;
  createdAt:string;
  assessmentMode?:'natural_language';
  comparisonOnly?:boolean;
};
