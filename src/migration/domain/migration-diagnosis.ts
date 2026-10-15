export type Finding = {
  id: string;
  path: string;
  line: number;
  endLine: number;
  snippet: string;
  dependencyType: string;
  reason: string;
  impact: string;
  suggestion: string;
  confidence: string;
  layer: string;
  symbol?: string | null;
  source?: 'STATIC' | 'MODEL';
  verification?: 'VERIFIED';
};

export const SCAN_COMPLETE_STATUSES: readonly string[] = ['AST_PARSED', 'TEXT_INSPECTED'];

export type Diagnosis = {
  schemaVersion: 'migration-diagnosis.v1';
  assetId: string;
  digest: string;
  createdAt: string;
  status: 'COMPLETE' | 'PARTIAL';
  dependencyStatus: 'EXPLICIT_BINDING' | 'NO_BINDING_IN_CHECKED_SCOPE' | 'UNKNOWN';
  findings: Finding[];
  coverage: Array<{ path: string; status: string }>;
  declarations: Array<{ path: string; line: number; name: string; parameters: string[]; asyncFunction: boolean; status: string }>;
  files: Array<{ path: string; sha256: string; bytes: number }>;
  ai: {
    status: 'RUNNING' | 'COMPLETE' | 'NOT_REQUESTED' | 'NOT_CONFIGURED' | 'FAILED';
    summary?: string;
    error?: string;
    suggestions?: Array<{ findingId: string; explanation: string; nextStep: string }>;
    model?: string;
    retryable: boolean;
    inputTruncated?: boolean;
    acceptedRuntimeBindings?: number;
    rejectedRuntimeBindings?: number;
  };
  scriptsExecuted: false;
  nativeExecution: 'NOT_RUN';
  scannerDigest: string;
  frameworks?: string[];
  plan?: Array<{
    category: 'AUTOMATIC' | 'OWNER_CONFIRMATION' | 'ENGINEERING';
    findingIds: string[];
    problem: string;
    change: string;
    impact: string;
  }>;
};
