import { z } from "zod";
import type { EvalPack } from "../../contracts.js";
import type { RunConfiguration } from "../../shared/contracts/run-configuration.js";
import type {
  ProjectInspection,
  TechnicalValidation,
  ToolDecision,
} from "./migration-model.js";
import type { PortableDiff, PortableGeneration } from "./migration-candidate-artifact.js";
import type { SkillAssetRecord } from "../../shared/contracts/skill-asset.js";
import type { StageEnvelope } from "./migration-stage-envelope.js";
import type {RuntimeLauncherBinding} from "../../shared/contracts/environment.js";

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

export type MigrationRunDeclaration = {
  pair: "AB" | "BC" | "AC" | "SC" | "CC";
  configuration: RunConfiguration;
  dataSnapshot: string;
  permissionBasis: string;
  sourceProjectRef: string;
  dependencyLockRef: string;
};

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
  }>;
  runs: Array<{
    jobId: string;
    pair: "AB" | "BC" | "AC" | "SC" | "CC";
    candidateDigest: string;
    comparisonFingerprint: string;
    packFingerprint: string;
    declaredPlan?: MigrationRunDeclaration;
    suiteSnapshot?: EvalPack;
    runtimeConfigurationDigest?: string;
  }>;
  assessment: "NOT_VALIDATED";
  nativeBindings?:{candidateDigest:string;bindings:import('../../shared/contracts/native-tool-catalog.js').NativeSkillBindings;recordedAt:string};
  runtimeDelivery?: RuntimeLauncherBinding;
  runtimeDeliveries?: Record<string, RuntimeLauncherBinding>;
  reviews?: Array<{
    candidateDigest: string;
    decision: "ACCEPTED" | "NEEDS_CHANGES";
    notes: string;
    recordedAt: string;
    source: "PRIVATE_ADMIN_RECORDED";
  }>;
  inspection?: ProjectInspection;
  sourceInspection?: ProjectInspection;
  analysis?: StageEnvelope<ProjectInspection>;
  decisions?: ToolDecision[];
  portableGenerations?: PortableGeneration[];
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
