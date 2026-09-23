import type { EvalPack,ModelRef } from '../../contracts.js';
import type { PreparedEvaluation } from '../../shared/contracts/prepared-evaluation.js';

export interface MigrationPreparationPackFactory {
  build(input:{preparation:PreparedEvaluation;analyzerModel:ModelRef;executionModel:ModelRef;judgeModel:ModelRef}):EvalPack;
}
