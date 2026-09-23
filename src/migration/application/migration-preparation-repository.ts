import type { EvalCase,EvalPack,EvaluationContextSnapshot,ModelRef } from '../../contracts.js';
import type { PreparedEvaluation } from '../../shared/contracts/prepared-evaluation.js';
import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';

export interface MigrationPreparationRepository {
  get(preparationId:string):Promise<PreparedEvaluation|null>;
  create(input:{
    skill:SkillAssetRecord;
    summary:string;
    cases:EvalCase[];
    holdoutCases?:EvalCase[];
    source:PreparedEvaluation['source'];
    assessmentMode?:'natural_language';
    comparisonOnly?:boolean;
    evaluationContext?:EvaluationContextSnapshot|null;
  }):Promise<PreparedEvaluation>;
  buildPack(input:{
    preparation:PreparedEvaluation;
    analyzerModel:ModelRef;
    executionModel:ModelRef;
    judgeModel:ModelRef;
  }):EvalPack;
}
