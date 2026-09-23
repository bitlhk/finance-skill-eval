import type { ProjectInspection } from '../domain/migration-model.js';

export interface MigrationHarnessSerializer {
  serialize(inspection:ProjectInspection):string|null;
}
