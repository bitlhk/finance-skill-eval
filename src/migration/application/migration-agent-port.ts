import type { AnalysisSupplement, RuntimeLibraryInventory } from '../domain/migration-dependency.js';

export type MigrationAnalysis =
  | {
      status: 'PRODUCED';
      payload: unknown;
      workspaceRoot?: string;
      libraryInventory?: RuntimeLibraryInventory;
      scanner?: Record<string, unknown> | null;
      outputCorrectionAttempts?:number;
    }
  | {
      status: 'ABSTAINED';
      reason: string;
      missing: string[];
      payload?: unknown;
      workspaceRoot?: string;
      libraryInventory?: RuntimeLibraryInventory;
      scanner?: Record<string, unknown> | null;
      outputCorrectionAttempts?:number;
    }
  | { status: 'FAILED'; reason: string; failureKind?:'OUTPUT_FORMAT'|'AGENT_EXECUTION' };

export type MigrationAnalyzer = (input: {
  assetDigest: string;
  runId: string;
  files: Record<string, Uint8Array>;
  supplements?: AnalysisSupplement[];
  targetRuntime?:import('../../shared/contracts/runtime-launcher.js').RuntimeLauncherCapabilities;
  deliveryContract?:Record<string,unknown>;
}) => Promise<MigrationAnalysis | null>;

export type MigrationImplementation =
  | { status: 'PRODUCED' | 'ABSTAINED'; payload: unknown; files: Record<string, string>; outputCorrectionAttempts?:number }
  | { status: 'FAILED'; reason: string; failureKind?:'OUTPUT_FORMAT'|'AGENT_EXECUTION' };

export type MigrationImplementer = (input: {
  assetDigest: string;
  runId: string;
  files: Record<string, Uint8Array>;
  decisions: unknown[];
  tools: unknown[];
  contract: Record<string, unknown>;
  deliveryContract?: Record<string, unknown>;
}) => Promise<MigrationImplementation | null>;
