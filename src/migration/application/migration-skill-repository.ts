import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';

/** Asset capabilities required by migration workflows, independent of filesystem storage. */
export interface MigrationSkillRepository {
  get(assetId:string):Promise<SkillAssetRecord|null>;
  readSource(assetId:string):Promise<string>;
  readFiles(assetId:string):Promise<Record<string,string>>;
  readArchive(assetId:string):Promise<Record<string,Uint8Array>>;
  uploadZip(buffer:Buffer,options?:{migrationInput?:boolean;version?:string}):Promise<SkillAssetRecord>;
}
