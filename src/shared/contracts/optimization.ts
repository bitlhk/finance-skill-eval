import type { SkillAssetRecord } from './skill-asset.js';
import type { AgentCompositionReceipt } from './agent-composition.js';

export type Optimization={
  loop?:import('../../improvement/domain/optimization-loop.js').OptimizationLoop;
  goal?:import('../../improvement/domain/optimization-loop.js').OptimizationGoal;
  evaluationFingerprint?:string;
  holdoutFingerprint?:string;
  effectReview?:import('../../improvement/domain/effect-review.js').EffectReviewResult;
  reviewJobId?:string;
  optimizationId:string;sourceJobId:string;sourceAssetId:string;createdAt:string;updatedAt:string;
  status:'diagnosing'|'validating'|'reevaluating'|'reviewing'|'final_verifying'|'review'|'adopted'|'retained'|'failed'|'cancelled';
  modelId:string;summary:string;findings:string[];
  changes:Array<{path:string;before:string;after:string;reason:string}>;
  candidate:SkillAssetRecord|null;rerunJobId:string|null;error:string|null;
  holdoutJobId?:string|null;holdoutVerified?:boolean;
  previousRerunJobIds?:string[];stages:Array<{stage:string;at:string}>;
  proposalOnly?:boolean;
  /** Caller-supplied design constraints, without test secrets or holdout answers. */
  constraints?:string;
  agentComposition?:AgentCompositionReceipt;
  abstainedReason?:string;
};
