export type EffectReviewResult = {status:'ABSTAINED';reason:string}|{status:'PRODUCED';review:{
  recommendation:'KEEP_CANDIDATE'|'CONTINUE_CANDIDATE'|'KEEP_BASELINE'|'INCONCLUSIVE';reason:string;
  improvements:string[];regressions:string[];evidenceIds:string[];
  tradeoff?:string;nextFocus?:string[];
}};
