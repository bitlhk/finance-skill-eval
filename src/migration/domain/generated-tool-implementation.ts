export type GeneratedToolImplementation = {
  callExecuted?: boolean;
  runtimeDependenciesPending?: string[];
  runtimeBindings?: Array<{ key: string; header: string }>;
  language: 'python' | 'java' | 'node';
  sourcePath: string;
  source: string;
  additionalFiles: Array<{ path: string; content: string }>;
  dependencies: string[];
  start?: string[];
  prepare?: string[];
  drift?: Array<{ where?: string; baseline?: unknown; observed?: unknown }>;
  changes?: Array<{ path?: string; change?: string; reason?: string }>;
  smokeInput: Record<string, unknown>;
  generatedBy: string;
  explanation: string;
  attempts: number;
  checks: Array<{
    name: 'PYTHON_COMPILE' | 'JSON_SMOKE' | 'JAVA_COMPILE' | 'NODE_CHECK';
    passed: true;
    message: string;
  }>;
};
