import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';
import type { Diagnosis } from '../domain/migration-diagnosis.js';

export interface MigrationDiagnosisPort {
  /** Read persisted evidence only; never start or await model work. */
  readCurrent(asset:SkillAssetRecord):Promise<Diagnosis|null>;
  diagnose(asset:SkillAssetRecord,retry?:boolean):Promise<Diagnosis>;
}
