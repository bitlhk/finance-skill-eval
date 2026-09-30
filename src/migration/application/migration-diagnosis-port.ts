import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';
import type { Diagnosis } from '../domain/migration-diagnosis.js';

export interface MigrationDiagnosisPort {
  diagnose(asset:SkillAssetRecord,retry?:boolean):Promise<Diagnosis>;
}
