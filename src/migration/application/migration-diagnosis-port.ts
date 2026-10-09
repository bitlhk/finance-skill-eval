import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';
import type { Diagnosis } from '../domain/migration-diagnosis.js';

export interface MigrationDiagnosisPort {
  peek?(asset:SkillAssetRecord):Promise<Diagnosis|null>;
  diagnose(asset:SkillAssetRecord,retry?:boolean,options?:{explain?:boolean}):Promise<Diagnosis>;
}
