import type {EvalCase,EvalPack,RuntimeExecutionEvidence} from '../../contracts.js';
import type {PairwiseJudge} from '../../judge.js';
import type {EvaluationCaseReport} from '../../report.js';
import {EvaluationCancelledError} from '../domain/errors.js';
import {evaluateMethods} from './evaluation-method.js';
import {plannedMethods} from './planned-methods.js';
import {answerEvidence} from '../domain/answer-evidence.js';
import {checkExecutionEvidence} from '../domain/execution-checks.js';

/** The live comparison and offline rescoring share scoring, not runtime execution. */
export async function evaluateComparison(input:{evalCase:EvalCase;left:RuntimeExecutionEvidence;right:RuntimeExecutionEvidence;
  presentationOrder?:'normal'|'swapped';
  judge:PairwiseJudge;profile:EvalPack['judgeProfile'];signal?:AbortSignal}):Promise<EvaluationCaseReport>{
  const {evalCase,left,right,signal}=input;
  signal?.throwIfAborted();
  const methods=plannedMethods(evalCase.evaluationPlan);
  const executionCriteria=evalCase.rubric.filter(c=>c.scope==='execution');
  if(executionCriteria.length&&!input.judge.assessesSidesIndependently){
    const timeoutMs=input.judge.executionCriteriaTimeoutMs??240_000;
    methods.push({id:'execution-criteria',version:input.judge.judgeId,kind:'MODEL',timeoutMs,
      async evaluate({evidence,signal}){
        if(!input.judge.executionCriteriaJudge)return executionCriteria.map(c=>({id:c.criterionId,status:'UNVERIFIED' as const,reason:'当前评判器未提供执行标准评判；答案质量分不能替代过程验证'}));
        const verdict=await input.judge.executionCriteriaJudge({evalCase:{...evalCase,rubric:executionCriteria},evidence},
          {requestId:`comparison-execution-${evidence.runId}-${evidence.side}-${evalCase.caseId}`,signal,timeoutMs});
        return executionCriteria.map(c=>{
          const checked=verdict.criteria?.find(item=>item.id===c.criterionId);
          return {id:c.criterionId,status:checked?.passed===true?'PASS' as const:checked?.passed===false?'FAIL' as const:'UNVERIFIED' as const,
            reason:checked?.reason??'缺少此执行标准的判断',evidenceRefs:checked?.evidenceRefs??[]};
        });
      }});
  }
  if(evalCase.stateFixture)methods.unshift({id:'business-state',version:'1',kind:'RULE',evaluate:({evidence})=>{
    const checks=checkExecutionEvidence(evidence).filter(c=>c.id==='execution.business-state');
    return checks.length?checks:[{id:'execution.business-state',status:'UNVERIFIED',reason:'缺少业务状态回执'}];
  }});
  const methodResults=methods.length?{
    left:await evaluateMethods({evalCase,evidence:left,signal},methods),
    right:await evaluateMethods({evalCase,evidence:right,signal},methods),
  }:undefined;
  let judge:EvaluationCaseReport['judge']=null,judgeError:string|null=null;
  try{
    if(!input.judge.assessesSidesIndependently&&(left.status!=='completed'||right.status!=='completed'))
      throw new Error('执行未完成，不计入专业质量评分；请修复运行环境后重测。');
    judge=await input.judge.compare({signal,evalCase,left:structuredClone(left),right:structuredClone(right),profile:input.profile,presentationOrder:input.presentationOrder});
    signal?.throwIfAborted();
  }catch(error){
    if(signal?.aborted||error instanceof EvaluationCancelledError)throw error;
    judgeError=error instanceof Error?error.message:String(error);
  }
  return {caseId:evalCase.caseId,name:evalCase.name,prompt:evalCase.prompt,evaluationGoal:evalCase.evaluationGoal,
    answerEvidence:{left:answerEvidence(evalCase,left),right:answerEvidence(evalCase,right)},
    left,right,judge,judgeError,...(methodResults?{methodResults}:{})};
}
