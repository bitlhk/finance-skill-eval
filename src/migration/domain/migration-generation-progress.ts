export type GenerationPhase='PREPARING'|'GENERATING'|'PACKAGING'|'STATIC_SCAN'|'CANDIDATE_ANALYSIS'|'PLAN_REVIEW';
/** Transient execution state, not evidence of candidate correctness or acceptance. */
export type MigrationGenerationProgress={
  status:'RUNNING'|'COMPLETED'|'FAILED';
  startedAt:string;
  finishedAt?:string;
  elapsedMs:number;
  steps:Array<{phase:GenerationPhase;startedAt:string;elapsedMs:number}>;
};
