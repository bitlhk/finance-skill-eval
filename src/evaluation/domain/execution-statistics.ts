/** All requested attempts stay in the denominator, including cancelled and missing cases. */
export function executionStatistics(total:number,caseIds:string[],attempts:Array<Array<{id:string;passed:boolean;unverified?:boolean;failureStage?:string}>>){
  return caseIds.map(caseId=>{
    const results=Array.from({length:total},(_,index)=>attempts[index]?.find(c=>c.id===caseId));
    const observed=results.filter(result=>result&&!result.failureStage&&!result.unverified);
    const passed=observed.filter(result=>result!.passed).length,failed=observed.length-passed;
    return {caseId,total,passed,failed,unverified:total-observed.length,coverage:observed.length/total,
      successRate:passed/total,allPassed:passed===total,variableOutcomes:passed>0&&failed>0};
  });
}
