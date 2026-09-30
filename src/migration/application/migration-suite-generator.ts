import type { EvalCase } from '../../contracts.js';

export type MigrationSuiteGenerator = (input: {
  skillId: string;
  skillSource: string;
  tools: string[];
  documentedInputs?: Array<{ toolName: string; input: unknown }>;
  maximumCases?: number;
  generationId: string;
  signal?: AbortSignal;
}) => Promise<{ summary: string; cases: EvalCase[] }>;
