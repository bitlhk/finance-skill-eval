import type {RoleCallOptions} from '../../agents/ports.js';
import type {AgentCompositionReceipt} from '../../shared/contracts/agent-composition.js';
import type {ImprovementJudgement} from '../domain/diagnosis.js';

/** The caller selects development evidence; holdout tasks and configuration values are excluded. */
export type ImprovementDiagnosisInput={
  modelId:string;
  sourceJobId:string;
  baseSolutionRevisionId:string;
  tools:Array<{toolId:string;name:string;form:string}>;
  runtimeConfiguration:Array<{dependencyId:string;key:string;provided:boolean;valid:boolean;sensitive:boolean}>;
  technicalEvidence:Array<{toolId:string;status:string;stages:Array<{name:string;passed:boolean}>}>;
  cases:Array<{caseId:string;task:string;runtimeStatus:string;runtimeErrorCode?:string;
    runtimeIdentityVerified:boolean;streamCompleted:boolean;toolTraceStatus:'COMPLETE'|'PARTIAL_OR_UNAVAILABLE';
    executionBudget?:{maxAgentIterations:number;owner?:'HARNESS';changeMechanism?:'BUILDER_REBUILD'};
    toolCalls:Array<{name:string;status:string}>;review:string|null;verdict:string|null}>;
  previousExperiments?:Array<{layer:string;outcome:string;passed?:number;total?:number}>;
  codeEvidence?:Array<{origin:'source'|'candidate';path:string;content:string}>;
  runtimeEvidence?:Array<{path:string;content:string}>;
  evaluationEvidence?:unknown;
  runtimeRequirements?:unknown;
  approvedReuseDesign?:unknown;
};
export type ImprovementDiagnosisResult={
  investigation?:unknown[];
  judgement:ImprovementJudgement;
  agentComposition:AgentCompositionReceipt;
  outputCorrection:{attempts:number;originalDigest:string;acceptedDigest:string};
};
export type ImprovementDiagnoser=(input:ImprovementDiagnosisInput,options:RoleCallOptions)=>Promise<ImprovementDiagnosisResult>;
