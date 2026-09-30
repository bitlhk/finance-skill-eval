import type { MigrationProject } from '../domain/migration-project.js';

export type LegacyMigrationSummary={id:string;schemaVersion:string;name:string|null;createdAt:string|null};

export interface MigrationProjectStore {
  runExclusive<T>(key:string,operation:()=>Promise<T>):Promise<T>;
  list():Promise<MigrationProject[]>;
  get(id:string):Promise<MigrationProject>;
  save(project:MigrationProject):Promise<void>;
  listLegacy():Promise<LegacyMigrationSummary[]>;
  readLegacy(id:string):Promise<unknown>;
}
