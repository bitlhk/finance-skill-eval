import type { SkillAssetRecord } from './skill-asset.js';

export type Optimization={
  optimizationId:string;sourceJobId:string;sourceAssetId:string;createdAt:string;updatedAt:string;
  status:'diagnosing'|'validating'|'reevaluating'|'review'|'adopted'|'retained'|'failed'|'cancelled';
  modelId:string;summary:string;findings:string[];
  changes:Array<{path:string;before:string;after:string;reason:string}>;
  candidate:SkillAssetRecord|null;rerunJobId:string|null;error:string|null;
  previousRerunJobIds?:string[];stages:Array<{stage:string;at:string}>;
};
