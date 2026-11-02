import { z } from 'zod';
import {capabilityRequirementSchema} from '../../shared/contracts/runtime-builder.js';

/** A reviewable hypothesis, not an instruction to mutate files or deploy a Launcher. */
export const improvementHypothesisSchema=z.strictObject({
  layer:z.enum(['SKILL','TOOL','CONFIGURATION','HARNESS','EVALUATION','UNKNOWN']),
  issue:z.string().min(1).max(2000),
  expectedBehavior:z.string().min(1).max(2000),
  evidenceCaseIds:z.array(z.string().min(1)).min(1).max(20),
  validation:z.string().min(1).max(2000),
  risk:z.string().min(1).max(2000),
  confidence:z.enum(['LOW','MEDIUM','HIGH']),
  toolIds:z.array(z.string().min(1)).max(5).optional(),
  projectPaths:z.array(z.string().min(1)).min(1).max(20).optional(),
  requiredCapabilities:z.array(capabilityRequirementSchema).min(1).max(8).optional(),
});

export type ImprovementHypothesis=z.infer<typeof improvementHypothesisSchema>;
export const improvementJudgementSchema=z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('PROPOSED'),hypothesis:improvementHypothesisSchema}),
  z.strictObject({status:z.literal('ABSTAINED'),reason:z.string().min(1).max(2000)}),
]);
export type ImprovementJudgement=z.infer<typeof improvementJudgementSchema>;
/** Safe planning diagnostics; never carries raw model output or provider text. */
export class ImprovementPlanningError extends Error{
  readonly statusCode=409;
  constructor(readonly fields:string[],readonly code:'MODEL_OUTPUT_INVALID'|'MODEL_CORRECTION_CHANGED_FACTS'='MODEL_OUTPUT_INVALID'){
    super(`${code==='MODEL_CORRECTION_CHANGED_FACTS'?'纠错结果改变了原始判断或证据':'优化规划结果不符合约定'}（${code}）${fields.length?`：${fields.join('；')}`:''}`);
  }
}
