import type { EnvironmentRecord } from '../../shared/contracts/environment.js';

export interface MigrationEnvironmentRepository {
  get(environmentId:string):Promise<EnvironmentRecord|null>;
}
