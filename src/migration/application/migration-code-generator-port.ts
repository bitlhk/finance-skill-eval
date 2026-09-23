import type { GeneratedToolImplementation } from '../domain/generated-tool-implementation.js';
import type { ProjectInspection,ToolDecision } from '../domain/migration-model.js';

export interface MigrationCodeGeneratorPort {
  generate(input:{
    archive:Record<string,Uint8Array>;
    inspection:ProjectInspection;
    decisions:ToolDecision[];
  }):Promise<Record<string,GeneratedToolImplementation>>;
}
