export type EvalCaseSummary = {
  caseId: string;
  name: string;
  prompt: string;
  evaluationGoal: string;
  requiredTools: string[];
};

export type EvalPackSummary = {
  packId: string;
  version: string;
  domain: string;
  targetSkillId: string;
  targetSkillVersion: string;
  description: string;
  caseCount: number;
  cases: EvalCaseSummary[];
  replayReady: boolean;
  fingerprint: string;
};

export type SkillAsset = {
  assetId: string;
  skillId: string;
  version: string;
  displayName: string;
  description: string;
  artifactSha256: string;
  fileCount: number;
  createdAt: string;
};

export type Preparation = {
  preparationId: string;
  skillAssetId: string;
  skillId: string;
  skillVersion: string;
  summary: string;
  cases: EvalCaseSummary[];
  source: "ai_generated" | "manual";
  createdAt: string;
};

export type Environment = {
  environmentId: string;
  name: string;
  type: "mcp_streamable_http" | "runtime_http";
  endpoint: string;
  credentialEnv: string | null;
  mcpEnvironmentIds: string[];
};

export type Catalog = {
  serviceVersion: string;
  evalPacks: EvalPackSummary[];
  uploadedSkills: SkillAsset[];
  preparations: Preparation[];
  environments: Environment[];
  runtimes: Array<{
    id: "replay" | "direct_model" | "runtime_http";
    label: string;
    status: "ready" | "configuration_required";
    realExecution: boolean;
    description: string;
  }>;
  modelRoles: Record<string, { configured: boolean; model: { modelId: string } }>;
};

export type Evidence = {
  side: "left" | "right";
  caseId: string;
  status: "completed" | "failed";
  modelId: string;
  skillVersion: string | null;
  output: string;
  elapsedMs: number;
  toolCalls: Array<{ name: string; status: string }>;
  runtimeIdentityVerified: boolean;
  error: string | null;
};

export type EvaluationJob = {
  jobId: string;
  status: "queued" | "preparing" | "running" | "judging" | "completed" | "failed" | "cancelled" | "interrupted";
  stageLabel: string;
  configuration: {
    packId?: string;
    preparationId?: string;
    runtime: { type: string; environmentId?: string };
    judgeMode: string;
  };
  pack: { targetSkillId: string; targetSkillVersion: string; caseCount: number } | null;
  progress: { completedRuns: number; totalRuns: number; caseId?: string; side?: string };
  evidence: Evidence[];
  report: null | {
    summary: {
      leftWins: number;
      rightWins: number;
      ties: number;
      headline: string;
      meanElapsedMs: { left: number; right: number };
    };
    cases: Array<{
      caseId: string;
      name: string;
      prompt: string;
      left: Evidence;
      right: Evidence;
      judge: null | {
        winner: "left" | "right" | "tie";
        confidence: string;
        summary: string;
        dimensions: Array<{
          id: string;
          label: string;
          leftScore: number;
          rightScore: number;
          reason: string;
        }>;
      };
      judgeError: string | null;
    }>;
    suggestions: Array<{ title: string; recommendation: string; type: string }>;
    reportFingerprint: string;
    runtimeAdapterId: string;
    judgeId: string;
  };
  error: null | { code: string; message: string; retryable: boolean };
  createdAt: string;
  updatedAt: string;
};
