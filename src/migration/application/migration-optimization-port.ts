import type { Optimization } from '../../shared/contracts/optimization.js';

export interface MigrationOptimizationPort {
  create(sourceJobId:string):Promise<Optimization>;
  get(optimizationId:string):Promise<Optimization>;
}
