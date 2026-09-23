import type { EvaluationJob } from '../../shared/contracts/evaluation-job.js';
import type { RunConfiguration } from '../../shared/contracts/run-configuration.js';

export interface MigrationEvaluationRunner {create(configuration:RunConfiguration):Promise<EvaluationJob>}
export interface MigrationEvaluationJobReader {get(jobId:string):EvaluationJob|null}
