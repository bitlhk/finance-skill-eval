export type GenerationPhase='PREPARING'|'GENERATING'|'PACKAGING'|'STATIC_SCAN'|'CANDIDATE_ANALYSIS'|'PLAN_REVIEW';
/** Persisted execution state, not evidence of candidate correctness or acceptance. */
export type MigrationGenerationProgress={
  status:'RUNNING'|'COMPLETED'|'FAILED'|'INTERRUPTED';
  startedAt:string;
  finishedAt?:string;
  elapsedMs:number;
  steps:Array<{phase:GenerationPhase;startedAt:string;elapsedMs:number;finishedAt?:string;status?:'RUNNING'|'COMPLETED'|'FAILED'}>;
  failure?:{phase:GenerationPhase;code:string;message:string;recoverable:boolean;fields?:string[]};
};

/** A pending artifact is not the adopted project candidate. Stage receipts are bound to one input digest. */
export type MigrationGenerationAttempt={
  attemptId:string;
  inputDigest:string;
  committedInputDigest?:string;
  baseAssetId:string;
  proposalId:string;
  version:string;
  progress:MigrationGenerationProgress;
  delivery?:{
    implementations?:Record<string,import('./generated-tool-implementation.js').GeneratedToolImplementation>;
    skillDelivery?:import('./migration-candidate-artifact.js').SkillDocumentDelivery;
    generationStats:{agentAttempts:number;outputCorrectionAttempts:number};
  };
  candidate?:import('../../shared/contracts/skill-asset.js').SkillAssetRecord;
  generations?:import('./migration-candidate-artifact.js').PortableGeneration[];
  diff?:import('./migration-candidate-artifact.js').PortableDiff[];
  generationStats?:{agentAttempts:number;outputCorrectionAttempts:number};
  failures?:Array<{recordedAt:string;failure:NonNullable<MigrationGenerationProgress['failure']>}>;
  inspectionCheckpoint?:{
    rules?:Pick<import('./migration-model.js').ProjectInspection,'assetId'|'assetDigest'|'skill'|'staticAnalysis'>;
    analysis?:import('./migration-model.js').ProjectInspection;
    inspection?:import('./migration-model.js').ProjectInspection;
  };
};

/** Explicitly safe errors: raw model/provider/SDK messages are never persisted. */
export class MigrationGenerationError extends Error{
  readonly statusCode=409;
  constructor(readonly failure:NonNullable<MigrationGenerationProgress['failure']>){super(failure.message+(failure.fields?.length?`（${failure.fields.join('；')}）`:''));}
}

export const generationPhaseLabels:Record<GenerationPhase,string>={PREPARING:'检查方案与源工程',GENERATING:'生成 Skill 和工具工程',PACKAGING:'组装候选包',STATIC_SCAN:'扫描候选源码',CANDIDATE_ANALYSIS:'分析候选能力与依赖',PLAN_REVIEW:'审查迁移方案落实情况'};
