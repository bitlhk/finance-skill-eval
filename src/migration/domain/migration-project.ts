import { z } from "zod";
import type { EvalPack } from "../../contracts.js";
import type {MigrationRunDeclaration} from './migration-run-declaration.js';
export type {MigrationRunDeclaration} from './migration-run-declaration.js';
import type {
  ProjectInspection,
  TechnicalValidation,
  ToolDecision,
} from "./migration-model.js";
import type { PortableDiff, PortableGeneration } from "./migration-candidate-artifact.js";
import type { SkillAssetRecord } from "../../shared/contracts/skill-asset.js";
import type { StageEnvelope } from "./migration-stage-envelope.js";
import type {RuntimeLauncherBinding} from "../../shared/contracts/environment.js";
import type {SolutionRevision} from './migration-solution-revision.js';
import type {RuntimeBuildRequirementsV1} from '../../shared/contracts/runtime-builder.js';
import type {MigrationImprovementPlan} from './migration-improvement-plan.js';
import type {MigrationImprovementTask} from './migration-improvement-task.js';

export type RuntimeReuse={environmentId:string;launcherEnvironmentId:string;environmentUpdatedAt:string;requirementsDigest:string;capabilitiesDigest:string;checkedAt:string};

export const migrationProjectIdSchema = z.string().regex(/^migration-[a-f0-9-]+$/u);

const skillAssetReferenceSchema = z.object({
  schemaVersion: z.literal("finance.skill-eval.skill-asset.v1"),
  assetId: z.string().min(1),
  skillId: z.string().min(1),
  version: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string(),
  sourceType: z.string().min(1),
  artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  skillFile: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
}).passthrough();

export const persistedMigrationProjectSchema = z.object({
  schemaVersion: z.literal("finance.skill-migration.v2"),
  id: migrationProjectIdSchema,
  revisionOf: migrationProjectIdSchema.optional(),
  name: z.string().min(1),
  createdAt: z.string().min(1),
  source: skillAssetReferenceSchema,
  candidate: skillAssetReferenceSchema.nullable(),
  candidateNotes: z.string(),
  candidateHistory: z.array(z.object({
    asset: skillAssetReferenceSchema,
    notes: z.string(),
    recordedAt: z.string().min(1),
    kind: z.enum(["migration", "optimization"]).optional(),
  }).passthrough()).optional(),
  suiteIds: z.array(z.string().min(1)).optional(),
  optimizations: z.array(z.object({
    optimizationId: z.string().min(1),
    sourceJobId: z.string().min(1),
    baseAssetId: z.string().min(1),
    candidateDigest: z.string().min(1),
  }).passthrough()).optional(),
  runs: z.array(z.object({
    jobId: z.string().min(1),
    pair: z.enum(["AB", "BC", "AC", "SC", "CC"]),
    candidateDigest: z.string().min(1),
    comparisonFingerprint: z.string().min(1),
    packFingerprint: z.string().min(1),
  }).passthrough()),
  assessment: z.literal("NOT_VALIDATED"),
}).passthrough();

export type MigrationProject = {
  schemaVersion: "finance.skill-migration.v2";
  id: string;
  name: string;
  createdAt: string;
  revisionOf?: string;
  source: SkillAssetRecord;
  candidate: SkillAssetRecord | null;
  candidateNotes: string;
  candidateHistory?: Array<{
    asset: SkillAssetRecord;
    notes: string;
    recordedAt: string;
    kind?: "migration" | "optimization";
  }>;
  suiteIds?: string[];
  optimizations?: Array<{
    optimizationId: string;
    sourceJobId: string;
    baseAssetId: string;
    candidateDigest: string;
    planId?:string;
  }>;
  runs: Array<{
    jobId: string;
    pair: "AB" | "BC" | "AC" | "SC" | "CC";
    candidateDigest: string;
    comparisonFingerprint: string;
    packFingerprint: string;
    solutionRevisions?: {left:SolutionRevision|null;right:SolutionRevision};
    declaredPlan?: MigrationRunDeclaration;
    suiteSnapshot?: EvalPack;
    runtimeConfigurationDigest?: string;
    reuseProposalId?:string;
    reuseAcceptanceTaskId?:string;
  }>;
  assessment: "NOT_VALIDATED";
  nativeBindings?:{candidateDigest:string;bindings:import('../../shared/contracts/native-tool-catalog.js').NativeSkillBindings;recordedAt:string};
  runtimeDelivery?: RuntimeLauncherBinding;
  runtimeDeliveries?: Record<string,RuntimeLauncherBinding>;
  runtimeReuse?:RuntimeReuse;
  runtimeRebuilds?: Array<{candidateDigest:string;requirements:RuntimeBuildRequirementsV1;createdAt:string}>;
  improvementPlans?: MigrationImprovementPlan[];
  improvementTasks?:MigrationImprovementTask[];
  toolOptimizationAttempts?: Array<{
    attemptId:string;
    planId:string;
    baseAssetId:string;
    candidate:SkillAssetRecord;
    toolId:string;
    summary:string;
    changedPaths:string[];
    changes?:Array<{path:string;beforeSha256:string;afterSha256:string;reason:string}>;
    validations:TechnicalValidation[];
    status:'TECHNICAL_PASSED'|'TECHNICAL_FAILED'|'ADOPTED';
    createdAt:string;
  }>;
  reviews?: Array<{
    candidateDigest: string;
    decision: "ACCEPTED" | "NEEDS_CHANGES";
    notes: string;
    recordedAt: string;
    source: "PRIVATE_ADMIN_RECORDED";
  }>;
  inspection?: ProjectInspection;
  sourceInspection?: ProjectInspection;
  reuseProposal?:import('./migration-reuse-design.js').MigrationReuseProposal;
  candidateReuseProposalId?:string;
  reuseAcceptancePlan?:import('./migration-reuse-acceptance.js').ReuseAcceptancePlan;
  reuseAcceptanceResults?:import('./migration-reuse-acceptance.js').ReuseAcceptanceResult[];
  analysis?: StageEnvelope<ProjectInspection>;
  decisions?: ToolDecision[];
  portableGenerations?: PortableGeneration[];
  generationStats?:{agentAttempts:number;outputCorrectionAttempts:number};
  portableGenerationDiff?: PortableDiff[];
  technicalValidations?: TechnicalValidation[];
};

/**
 * The repository validates stable persistence discriminators here. Nested historic data stays
 * forward-compatible while its schemas are moved out of the legacy orchestration service.
 */
export function parseMigrationProject(input: unknown): MigrationProject {
  persistedMigrationProjectSchema.parse(input);
  return input as MigrationProject;
}
