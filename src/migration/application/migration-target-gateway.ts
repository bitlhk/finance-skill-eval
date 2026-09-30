import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';
import type { MigrationNativeTarget,MigrationTargetRun } from '../domain/migration-target.js';

export interface MigrationTargetGateway {
  target():Promise<MigrationNativeTarget>;
  get(runId:string):Promise<MigrationTargetRun>;
  start(asset:SkillAssetRecord,profileId:string):Promise<MigrationTargetRun>;
}
