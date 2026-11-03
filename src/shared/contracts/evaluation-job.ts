import type { EvaluationProgress } from '../../runner.js';
import type { EvaluationReport } from '../../report.js';
import type { FrozenQuestionSet } from '../../contracts.js';
import type { RunConfiguration } from './run-configuration.js';

export type EvaluationJobStatus='queued'|'preparing'|'running'|'judging'|'completed'|'failed'|'cancelled'|'interrupted';
export type EvaluationJob={
  executionAttempts?:Array<{index:number;status:'RUNNING'|'COMPLETED'|'FAILED';report?:EvaluationReport;error?:string;finalization?:Record<string,unknown>}>;
  executionRepetitionsStopped?:string;
  evaluationSpec?:import('../../contracts.js').EvalPack;
  rescorings?:Array<{id:string;createdAt:string;sourceReportFingerprint:string;judgeId:string;judgeConfigurationDigest?:string;cases:import('../../report.js').EvaluationCaseReport[];
    repetitions?:number;attempts?:Array<{index:number;presentationOrder:string;cases:import('../../report.js').EvaluationCaseReport[]}>;
    stability?:ReturnType<typeof import('../../evaluation/application/repeated-assessment.js').assessmentStability>}>;
  schemaVersion:'finance.skill-eval.job.v1';jobId:string;status:EvaluationJobStatus;stageLabel:string;configuration:RunConfiguration;
  questionSet?:FrozenQuestionSet;pack:{packId:string;version:string;targetSkillId:string;targetSkillVersion:string;caseCount:number}|null;
  progress:Pick<EvaluationProgress,'completedRuns'|'totalRuns'|'caseId'|'side'>;evidence:EvaluationProgress['evidence'][];
  live?:Record<string,{caseId:string;side:'left'|'right';output:string;status:string;toolCalls:Array<{name:string;status:string}>}>;
  cancellation?:{requestedAt:string;workerSettledAt?:string;scope:'EVAL_WORKER_NOT_REMOTE_PROCESS_PROOF'};
  finalization?:Record<string,unknown>;
  executionSnapshot?:{variants:unknown;models:unknown;cases:Array<{caseId:string;name:string;prompt:string}>;packFingerprint:string};
  report:EvaluationReport|null;error:{code:string;message:string;retryable:boolean}|null;
  createdAt:string;startedAt:string|null;completedAt:string|null;updatedAt:string;
};
