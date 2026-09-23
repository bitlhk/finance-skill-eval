import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';
import type { Diagnosis } from '../domain/migration-diagnosis.js';
import type { MigrationNativeTarget } from '../domain/migration-target.js';

export interface MigrationLegacyCandidateGenerator {
  regenerationArchive(archive:Record<string,Uint8Array>,base:SkillAssetRecord):Record<string,Uint8Array>;
  generate(input:{
    archive:Record<string,Uint8Array>;
    base:SkillAssetRecord;
    diagnosis:Diagnosis;
    version:string;
    target:{runtime:string;environmentId?:string;intent:string};
    simulation?:{id:string;target:MigrationNativeTarget};
  }):{
    files:Record<string,Uint8Array>;
    diff:Array<{path:string;operation:string;before:string;after:string}>;
    resources:unknown[];
  };
}
