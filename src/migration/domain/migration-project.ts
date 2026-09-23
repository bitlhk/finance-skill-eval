import { z } from "zod";
import type { EvalPack } from "../../contracts.js";
import type { RunConfiguration } from "../../service/contracts.js";
import type {
  ProjectInspection,
  TechnicalValidation,
  ToolDecision,
} from "./migration-model.js";
import type { PortableDiff, PortableGeneration } from "./migration-candidate-artifact.js";
import type { SkillAssetRecord } from "../../shared/contracts/skill-asset.js";
import type { StageEnvelope } from "./migration-stage-envelope.js";

export const migrationProjectIdSchema = z.string().regex(/^migration-[a-f0-9-]+$/u);

const persistedMigrationProjectSchema = z.object({
  schemaVersion: z.enum(["finance.skill-migration.v0.1", "finance.skill-migration.v2"]),
  id: migrationProjectIdSchema,
}).passthrough();

export type MigrationRunDeclaration = {
  pair: "AB" | "BC" | "AC" | "SC";
  configuration: RunConfiguration;
  dataSnapshot: string;
  permissionBasis: string;
  sourceProjectRef: string;
  dependencyLockRef: string;
};

export type MigrationProject = {
  schemaVersion: "finance.skill-migration.v0.1" | "finance.skill-migration.v2";
  id: string;
  name: string;
  createdAt: string;
  legacySourceProjectId?: string;
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
    pair: "AB" | "BC" | "AC" | "SC";
    candidateDigest: string;
    comparisonFingerprint: string;
    packFingerprint: string;
    declaredPlan?: MigrationRunDeclaration;
    suiteSnapshot?: EvalPack;
    runtimeConfigurationDigest?: string;
  }>;
  assessment: "NOT_VALIDATED";
  targetRuns?: string[];
  simulationProfile?: string;
  reviews?: Array<{
    candidateDigest: string;
    decision: "ACCEPTED" | "NEEDS_CHANGES";
    notes: string;
    recordedAt: string;
    source: "PRIVATE_ADMIN_RECORDED";
  }>;
  generation?: {
    candidateDigest: string;
    target: { runtime: string; environmentId?: string; intent: string };
    diff: Array<{ path: string; operation: string; before: string; after: string }>;
    generatedAt: string;
  };
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
