import type { Optimization } from '../../shared/contracts/optimization.js';

export interface MigrationOptimizationPort {
  create(sourceJobId:string,proposalOnly?:boolean,constraints?:string):Promise<Optimization>;
  get(optimizationId:string):Promise<Optimization>;
  propose?(sourceJobId:string,constraints?:string):Promise<Optimization>;
  decide?(optimizationId:string,decision:'adopt'|'retain'|'cancel'):Promise<Optimization>;
}
