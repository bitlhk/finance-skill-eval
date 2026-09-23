import type { MigrationProject } from '../domain/migration-project.js';

export interface MigrationProjectStore {
  runExclusive<T>(key:string,operation:()=>Promise<T>):Promise<T>;
  list():Promise<MigrationProject[]>;
  get(id:string):Promise<MigrationProject>;
  save(project:MigrationProject):Promise<void>;
}
