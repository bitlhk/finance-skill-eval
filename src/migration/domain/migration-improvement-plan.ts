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
  requiredCapabilities:z.array(capabilityRequirementSchema).min(1).max(8).optional(),
});

export type ImprovementHypothesis=z.infer<typeof improvementHypothesisSchema>;
export type MigrationImprovementPlan={
  planId:string;
  sourceJobId:string;
  baseSolutionRevisionId:string;
  candidateDigest:string;
  developmentCaseIds:string[];
  createdAt:string;
  modelId:string;
  status:'PROPOSED'|'ABSTAINED';
  hypothesis:ImprovementHypothesis|null;
  abstainReason:string|null;
  /** Content digests and count only; model text stays out of the public plan. */
  outputCorrection?:{attempts:number;originalDigest:string;acceptedDigest:string};
};
