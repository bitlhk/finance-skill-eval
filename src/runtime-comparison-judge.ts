import type {ModelAdapter} from './adapters.js';
import {judgeResultSchema,type JudgeResult,type ModelRef} from './contracts.js';
import {ModelGoalJudge,GOAL_JUDGE_POLICY_VERSION,type JudgeSkillContract} from './goal-judge.js';
import type {PairwiseJudge} from './judge.js';

type SideAssessment=NonNullable<JudgeResult['runtimeComparison']>['left'];

/** Same candidate, independent goal evidence; never a relative winner. */
export class ModelRuntimeComparisonJudge implements PairwiseJudge {
  readonly assessesSidesIndependently=true;
  readonly judgeId:string;
  constructor(private readonly adapter:ModelAdapter,private readonly model:ModelRef,private readonly skills:Partial<Record<'left'|'right',JudgeSkillContract>>={}) {
    this.judgeId=`model-runtime-goals:${GOAL_JUDGE_POLICY_VERSION}:${adapter.adapterId}:${model.providerId}:${model.modelId}`;
  }
  async compare(input:Parameters<PairwiseJudge['compare']>[0]):Promise<JudgeResult> {
    const assess=async(side:'left'|'right'):Promise<SideAssessment>=>{
      input.signal?.throwIfAborted();
      if(input[side].status!=='completed')return {status:'unavailable',error:'Runtime execution did not complete'};
      const judge=new ModelGoalJudge({adapterId:this.adapter.adapterId,
        complete:request=>this.adapter.complete({...request,requestId:`${request.requestId}-${side}`}),
      },this.model,this.skills[side]);
      try {
        const result=await judge.compare({...input,left:input[side],right:input[side]});
        input.signal?.throwIfAborted();
        if(!result.goalAssessment)throw Error('Goal assessment missing');
        return {status:'assessed',assessment:result.goalAssessment};
      } catch(error) {
        if(input.signal?.aborted)throw error;
        return {status:'unavailable',error:error instanceof Error?error.message:String(error)};
      }
    };
    const left=await assess('left'),right=await assess('right');
    const describe=(result:SideAssessment)=>result.status==='assessed'?`${result.assessment.verdict}: ${result.assessment.reason}`:`unavailable: ${result.error}`;
    return judgeResultSchema.parse({runtimeComparison:{left,right},confidence:'medium',dimensions:[],
      summary:`Left: ${describe(left)}; Right: ${describe(right)}`,reviewerLabel:'Independent Runtime goal assessment'});
  }
}
