import type { SkillAssetRecord } from './skill-asset.js';

export type Optimization={
  optimizationId:string;sourceJobId:string;sourceAssetId:string;createdAt:string;updatedAt:string;
  status:'diagnosing'|'validating'|'reevaluating'|'final_verifying'|'review'|'adopted'|'retained'|'failed'|'cancelled';
  modelId:string;summary:string;findings:string[];
  changes:Array<{path:string;before:string;after:string;reason:string}>;
  candidate:SkillAssetRecord|null;rerunJobId:string|null;error:string|null;
  holdoutJobId?:string|null;holdoutVerified?:boolean;
  previousRerunJobIds?:string[];stages:Array<{stage:string;at:string}>;
  proposalOnly?:boolean;
  /** Caller-supplied design constraints, without test secrets or holdout answers. */
  constraints?:string;
};
