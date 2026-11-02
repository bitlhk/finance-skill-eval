import type {EvalCase,RuntimeExecutionEvidence} from '../../contracts.js';
import type {RoleCallOptions} from '../../agents/ports.js';

export type CriterionJudgeInput={
  evalCase:EvalCase;evidence:RuntimeExecutionEvidence;
  requirements?:ReadonlyArray<{id:string}>;tools?:unknown;
};
export type CriterionVerdict={passed:boolean;reason:string;
  requirementResults?:Array<{id:string;passed:boolean;reason:string}>};
export type CriterionJudge=(input:CriterionJudgeInput,options:RoleCallOptions)=>Promise<CriterionVerdict>;
