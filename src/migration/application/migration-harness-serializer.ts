import type { ProjectInspection } from '../domain/migration-model.js';

export interface MigrationHarnessSerializer {
  serialize(inspection:ProjectInspection,runtimeType?:string):string|null;
}
