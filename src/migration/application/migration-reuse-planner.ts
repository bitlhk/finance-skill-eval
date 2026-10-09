import type {ReuseDesign,ReuseReview} from '../domain/migration-reuse-design.js';
import type {ProjectInspection,MigrationPlan} from '../domain/migration-model.js';

export type MigrationReusePlanner=(input:
  | {mode:'PROPOSE';sourceFiles:Record<string,string>;inspection:ProjectInspection;toolPlan:MigrationPlan;deliveryContract?:Record<string,unknown>}
  | {mode:'REVIEW';candidateFiles:Record<string,string>;sourceFiles:Record<string,string>;sourceInspection:ProjectInspection;candidateInspection:ProjectInspection;design:ReuseDesign;deliveryContract?:Record<string,unknown>},
) => Promise<unknown>;
export type MigrationReuseJudgement={status:'PROPOSED';design:ReuseDesign}|{status:'REVIEWED';review:ReuseReview}|{status:'ABSTAINED';reason:string};
