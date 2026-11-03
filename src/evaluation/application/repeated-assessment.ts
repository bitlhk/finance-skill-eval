import {z} from 'zod';

export const assessmentRepetitionsSchema=z.number().int().min(1).max(5).default(1);
/** Repeats grading of frozen evidence, never business execution or optimization rounds. */
export async function repeatAssessment<T>(count:number,assess:(index:number)=>Promise<T>,signal?:AbortSignal){
  assessmentRepetitionsSchema.parse(count);
  const attempts:T[]=[];
  for(let index=0;index<count;index++){signal?.throwIfAborted();attempts.push(await assess(index));signal?.throwIfAborted();}
  return attempts;
}

export function assessmentStability(attempts:Array<Array<{caseId:string;outcome:string|null}>>){
  const ids=[...new Set(attempts.flatMap(attempt=>attempt.map(c=>c.caseId)))];
  return ids.map(caseId=>{
    const outcomes=attempts.map(attempt=>attempt.find(c=>c.caseId===caseId)?.outcome??null);
    const counts:Record<string,number>=Object.create(null);
    for(const outcome of outcomes)if(outcome!==null)counts[outcome]=(counts[outcome]??0)+1;
    const assessed=outcomes.filter(outcome=>outcome!==null).length;
    return {caseId,attempts:attempts.length,assessed,unavailable:attempts.length-assessed,counts,
      coverage:attempts.length?assessed/attempts.length:0,
      agreement:assessed?Math.max(...Object.values(counts))/assessed:null};
  });
}
