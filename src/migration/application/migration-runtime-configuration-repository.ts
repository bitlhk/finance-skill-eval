import type { Dependency } from '../domain/migration-dependency.js';
import type { ConnectionCheck,RuntimeTestConfig } from '../domain/migration-runtime-configuration.js';
export type { ConnectionCheck,RuntimeTestConfig } from '../domain/migration-runtime-configuration.js';

export interface MigrationRuntimeConfigurationRepository {
  get(migrationId:string):Promise<RuntimeTestConfig>;
  save(migrationId:string,dependency:Dependency,value:unknown,revision:number):Promise<RuntimeTestConfig>;
  check(migrationId:string,result:Omit<ConnectionCheck,'id'|'checkedAt'>):Promise<ConnectionCheck>;
}
