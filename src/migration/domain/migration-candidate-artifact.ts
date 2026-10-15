import type { GeneratedToolImplementation } from './generated-tool-implementation.js';
import type { ToolDecision } from './migration-model.js';

export type PortableGeneration = {
  toolId: string;
  toolName: string;
  form: ToolDecision['form'];
  files: string[];
  entrypoint?: string;
  callExecuted?: boolean;
  runtimeDependenciesPending?: string[];
  runtimeBindings?: GeneratedToolImplementation['runtimeBindings'];
  start?: string[];
  prepare?: string[];
  drift?: GeneratedToolImplementation['drift'];
  changes?: GeneratedToolImplementation['changes'];
  readyForValidation: boolean;
  todo: string[];
  generatedBy?: string;
  explanation?: string;
  attempts?: number;
  checks?: GeneratedToolImplementation['checks'];
};

export type PortableDiff = {
  path: string;
  operation: 'ADD' | 'MODIFY' | 'DELETE';
  before: string;
  after: string;
  reason?:string;
};

export type SkillDocumentDelivery = { files: Record<string, string>; retiredSources?:import('./migration-source-retirement.js').RetiredSource[] };
