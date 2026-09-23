import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';
import type { TechnicalValidation,ToolInspection } from '../domain/migration-model.js';

export type MigrationLaunchable = {
  start?: string[];
  prepare?: string[];
};

export interface MigrationTechnicalValidator {
  validateScript(input:{
    asset:SkillAssetRecord;
    archive:Record<string,Uint8Array>;
    tool:ToolInspection;
    request?:unknown;
    context?:Record<string,unknown>;
    signal?:AbortSignal;
  }):Promise<TechnicalValidation>;

  validateMcp(input:{
    asset:SkillAssetRecord;
    tool:ToolInspection;
    archive?:Record<string,Uint8Array>;
    service?:MigrationLaunchable;
    endpoint?:string;
    arguments?:Record<string,unknown>;
    headers?:Record<string,string>;
    environment?:Record<string,string>;
    signal?:AbortSignal;
  }):Promise<TechnicalValidation>;
}
