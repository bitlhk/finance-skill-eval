import type { ModelRef } from '../../contracts.js';

export interface MigrationEvaluationModels {
  analyzer():ModelRef;
  judge():ModelRef;
}
