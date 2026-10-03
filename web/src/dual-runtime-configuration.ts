import type {ModelRef} from './types';

/** The same Skill on two runtimes is independent goal assessment, not a relative winner. */
export function dualRuntimeConfiguration(model: ModelRef, parameters: Record<string, number>) {
  const execution = {...model, parameters: {...parameters}};
  return {
    evaluationMode: 'candidate_runtime_comparison' as const,
    judgeMode: 'model' as const,
    executionModel: execution,
    leftExecutionModel: structuredClone(execution),
    rightExecutionModel: structuredClone(execution),
  };
}
