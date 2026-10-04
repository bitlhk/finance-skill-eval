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
  holdoutCaseCount?: number;
  holdoutRequiredTools?: string[];
  cases: EvalCaseSummary[];
  replayReady: boolean;
  deterministicReady?: boolean;
  fingerprint: string;
  models: {
    execution: { left: ModelRef; right: ModelRef };
  };
  variants: { left: SkillVariant; right: SkillVariant };
};

export type ModelRef = {
  providerId: string;
  modelId: string;
  upstreamModelId?: string;
  label?: string;
  providerLabel?: string;
  availability?: "ready" | "unverified" | "unavailable";
  statusNote?: string;
  parameters?: Record<string, string | number | boolean | null | {type:'disabled'}>;
};

export type SkillVariant =
  | { mode: "without_target_skill"; skillId: string }
  | { mode: "skill_version"; skillId: string; version: string; artifactSha256?: string };

export type FeaturedSkill = {
  skillId: string;
  displayName: string;
  roleName: string;
  category: string;
  iconKey: "wealth" | "insurance" | "research" | "risk" | "audit" | "coach";
  author?: string;
  featuredOrder: number;
  summary: string;
  capabilities: string[];
  versions: Array<{
    version: string;
    packId: string;
    packVersion: string;
    replayReady: boolean;
    artifactSha256: string | null;
  }>;
  taskCount: number;
  requiredTools: string[];
  evaluationStatus: "ready" | "environment_required" | "pack_required";
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
  deterministicReady?: boolean;
  preparationId: string;
  skillAssetId: string;
  skillId: string;
  skillVersion: string;
  summary: string;
  cases: EvalCaseSummary[];
  source: "ai_generated" | "manual";
  createdAt: string;
};

type EnvironmentRecord=import('../../src/shared/contracts/environment').EnvironmentRecord;
export type Environment=EnvironmentRecord extends infer Item?Item extends EnvironmentRecord?Omit<Item,'createdAt'|'updatedAt'>:never:never;

export type EnvironmentInspection = {
  status: "ready" | "failed";
  elapsedMs: number;
  error: string | null;
  toolCount: number;
  tools: Array<{ name: string }>;
  mcpServers: Array<{
    environmentId: string;
    name: string;
    status: "ready" | "failed";
    toolNames: string[];
    error: string | null;
  }>;
  capabilities?:import('../../src/shared/contracts/runtime-launcher').RuntimeLauncherCapabilities;
};

export type MigrationRuntime = {
  runtimeId: string;
  launcherEnvironmentId: string;
  name: string;
  runtimeType: "openjiuwen"|"agentscope"|"ea"|"generic_http";
  endpoint: string;
  defaultModelId: string;
  mcpEnvironmentIds:string[];
  toolCount:number;
  models: ModelRef[];
  transport:'runtime_launcher';
};

export type Catalog = {
  publicDemo?: boolean;
  managedWorkspace?: boolean;
  serviceVersion: string;
  featuredSkills: FeaturedSkill[];
  evalPacks: EvalPackSummary[];
  uploadedSkills: SkillAsset[];
  preparations: Preparation[];
  environments: Environment[];
  executionRuntimes: MigrationRuntime[];
  launcherTrustReferences?:Array<{reference:string;label:string;baseUrlPrefix:string}>;
  runtimes: Array<{
    id: "replay" | "direct_model" | "runtime_launcher";
    label: string;
    status: "ready" | "configuration_required";
    realExecution: boolean;
    description: string;
  }>;
  modelRoles: Record<string, { configured: boolean; model: ModelRef }>;
};

export type Evidence = {
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  metadata?: { dataMode?: string; skillArtifactSha256?: string | null; runtimeVersion?: string; integrationVersion?: string; referenceFilesRead?: Record<string, string>;
    runtime?:{type:string;version:string};loadedSkillDigest?:string;methodDigest?:string;installationDigest?:string;
    artifactLockSha256?:string;runtimeLockSha256?:string;executionHistoryRequestId?:string;retainedEvidenceRef?:string|Record<string,string>;
    declaredModelParameters?:Record<string,unknown>;modelParametersBasis?:string;modelParametersVerified?:boolean;
    businessDate?:string;businessTimeZone?:string;publicationStatus?:string;isolationRestartMs?:number;
    executionDisposition?:'NOT_EXECUTED';blockedByCaseId?:string;
  };
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
  questionSet?: { source: "ai_generated"; cases: EvalCaseSummary[]; summary: string; fingerprint: string; model: ModelRef; sourceFiles: string[]; generatedAt: string };
  live?: Record<string, { caseId: string; side: "left" | "right"; output: string; status: string; toolCalls: Array<{ name: string; status: string }> }>;
  jobId: string;
  status: "queued" | "preparing" | "running" | "judging" | "completed" | "failed" | "cancelled" | "interrupted";
  stageLabel: string;
  configuration: {
    packId?: string;
    preparationId?: string;
    runtime: { type: string; environmentId?: string };
    judgeMode: string;
    evaluationMode?: 'pairwise' | 'candidate_assessment' | 'service_comparison' | 'candidate_runtime_comparison';
    caseSource?: "fixed" | "ai_generated";
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
        goalAssessment?:{verdict:'PASS'|'FAIL'|'INDETERMINATE';reason:string;checks:Array<{criterion:string;verdict:'PASS'|'FAIL'|'INDETERMINATE';reason:string;evidence:string}>};
        serviceComparison?:{verdict:'PASS'|'FAIL'|'INDETERMINATE';reason:string;checks:Array<{criterion:string;verdict:'PASS'|'FAIL'|'INDETERMINATE';reason:string;originalEvidence:string;candidateEvidence:string}>};
        runtimeComparison?:{left:{status:'assessed';assessment:{verdict:'PASS'|'FAIL'|'INDETERMINATE';reason:string;checks:Array<{criterion:string;verdict:'PASS'|'FAIL'|'INDETERMINATE';reason:string;evidence:string}>}}|{status:'unavailable';error:string};right:{status:'assessed';assessment:{verdict:'PASS'|'FAIL'|'INDETERMINATE';reason:string;checks:Array<{criterion:string;verdict:'PASS'|'FAIL'|'INDETERMINATE';reason:string;evidence:string}>}}|{status:'unavailable';error:string}};
        winner?: "left" | "right" | "tie";
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
