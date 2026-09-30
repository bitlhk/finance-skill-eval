import type { GeneratedToolImplementation } from '../domain/generated-tool-implementation.js';
import type { SkillDocumentDelivery } from '../domain/migration-candidate-artifact.js';
import type { ProjectInspection } from '../domain/migration-model.js';

export interface MigrationAgentResultMapper {
  inspection(input:{
    payload:unknown;
    assetId:string;
    assetDigest:string;
    scanner?:Record<string,unknown>|null;
    files?:Record<string,string>;
  }):ProjectInspection;
  contractSample(tool:{samples?:Array<{input:unknown}>}|undefined):{input:unknown}|{reason:string};
  generatedImplementations(payload:unknown,files:Record<string,string>,toolNameById:Record<string,string>):Record<string,GeneratedToolImplementation>;
  skillDocumentDelivery(payload:unknown,files:Record<string,string>):SkillDocumentDelivery|null;
}
