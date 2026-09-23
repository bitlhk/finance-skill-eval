import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';
import type { GeneratedToolImplementation } from '../domain/generated-tool-implementation.js';
import type { PortableDiff,PortableGeneration,SkillDocumentDelivery } from '../domain/migration-candidate-artifact.js';
import type { ProjectInspection,ToolDecision } from '../domain/migration-model.js';

export type MigrationCandidatePackage = {
  files:Record<string,Uint8Array>;
  generations:PortableGeneration[];
  diff:PortableDiff[];
};

export interface MigrationCandidatePackager {
  package(input:{
    archive:Record<string,Uint8Array>;
    base:SkillAssetRecord;
    inspection:ProjectInspection;
    decisions:ToolDecision[];
    version:string;
    implementations?:Record<string,GeneratedToolImplementation>;
    skillDelivery?:SkillDocumentDelivery;
  }):MigrationCandidatePackage;
}
