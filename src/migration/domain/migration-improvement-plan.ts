import type {ImprovementHypothesis} from '../../improvement/domain/diagnosis.js';
export {improvementHypothesisSchema, type ImprovementHypothesis} from '../../improvement/domain/diagnosis.js';

export type MigrationImprovementPlan={
  agentComposition?:import('../../shared/contracts/agent-composition.js').AgentCompositionReceipt;
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
