import type {ImprovementJudgement} from '../domain/diagnosis.js';
import {comparableEvaluations,selectOptimizationCandidate,type AdjustmentResult,type CandidateRef,type OptimizationEvaluation,type OptimizationLoop,type OptimizationRound} from '../domain/optimization-loop.js';
import type {EffectReviewResult,RoleCallOptions} from '../../agents/ports.js';
import {runRoundWorkflow} from './round-workflow.js';

export type OptimizationLoopPorts={
  diagnose(baseline:OptimizationEvaluation,history:OptimizationRound[],options:RoleCallOptions):Promise<ImprovementJudgement>;
  adjust(baseline:CandidateRef,diagnosis:ImprovementJudgement,options:RoleCallOptions):Promise<AdjustmentResult>;
  evaluate(candidate:CandidateRef,options:RoleCallOptions):Promise<OptimizationEvaluation>;
  review(before:OptimizationEvaluation,after:OptimizationEvaluation,round:OptimizationRound,options:RoleCallOptions,incumbent:OptimizationEvaluation):Promise<EffectReviewResult>;
  save(state:OptimizationLoop):Promise<void>;
  activate?(evaluation:OptimizationEvaluation):Promise<void>;
};
export type OptimizationResume={working:OptimizationEvaluation;incumbent:OptimizationEvaluation;candidate:CandidateRef;contextChange:{reference:string;reason:string}};

/** Owns orchestration only. Agents diagnose, change and review; immutable evidence controls selection. */
export async function runOptimizationLoop(state:OptimizationLoop,baseline:OptimizationEvaluation,ports:OptimizationLoopPorts,signal:AbortSignal,resume?:OptimizationResume){
  const remaining=Date.parse(state.deadlineAt)-Date.now();
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(new Error('优化达到时间预算')),Math.max(0,remaining));
  const bounded=AbortSignal.any([signal,controller.signal]);
  let best=resume?.incumbent??baseline,working=resume?.working??baseline;
  state.baselineEvaluationId??=baseline.id;
  const hasImprovement=()=>state.bestEvaluationId!==state.baselineEvaluationId;
  const setWorking=(evaluation:OptimizationEvaluation)=>{working=evaluation;state.working=evaluation.candidate;state.workingEvaluationId=evaluation.id;};
  setWorking(working);
  const save=()=>ports.save(structuredClone(state));
  const finish=(status:OptimizationLoop['status'],reason:string)=>{state.status=status;state.reason=reason;state.finishedAt=new Date().toISOString();};
  try{
    if(remaining<=0)throw new Error('优化达到时间预算');
    if(!comparableEvaluations(baseline,baseline))throw new Error('基线评测未完整完成，不能进入优化');
    if(state.goal.protectedCaseIds?.some(id=>!baseline.cases.some(c=>c.id===id)))throw new Error('必须通过的案例不属于本次开发集');
    if(resume&&(!state.waiting||!state.rounds.length))throw new Error('没有可恢复的等待轮次');
    const start=resume?state.rounds.length:1;
    let round:OptimizationRound,options:RoleCallOptions,isResuming=false;
    const stage=async(value:OptimizationRound['stage'])=>{round.stage=value;state.stage=value;bounded.throwIfAborted();await save();};
    await runRoundWorkflow<ImprovementJudgement,CandidateRef,OptimizationEvaluation,EffectReviewResult>({
      firstRound:start,maxRounds:state.goal.maxRounds,signal:bounded,
      prepare:async(number,resuming)=>{
        isResuming=resuming;
        round=resuming?state.rounds.at(-1)!:{number,baseline:working.candidate,stage:'DIAGNOSIS'};
        if(!resuming)state.rounds.push(round);
        options={requestId:`${state.id}-${number}`,signal:bounded,
          timeoutMs:Math.max(1,Date.parse(state.deadlineAt)-Date.now()),
          onComposition:async receipt=>{(round.compositions??=[]).push(receipt);await save();}};
        return true;
      },
      ...(resume?{resume:async()=>{round.candidate=resume.candidate;delete state.waiting;return resume.candidate;}}:{}),
      diagnose:async()=>{
        await stage('DIAGNOSIS');
        round.diagnosis=await ports.diagnose(working,state.rounds.slice(0,-1),options);
        if(round.diagnosis.status==='ABSTAINED'){finish(hasImprovement()?'REVIEW':'STOPPED',round.diagnosis.reason);return {status:'STOP'};}
        return {status:'READY',value:round.diagnosis};
      },
      adjust:async diagnosis=>{
        await stage('ADJUSTMENT');
        const adjustment=await ports.adjust(working.candidate,diagnosis,options);
        bounded.throwIfAborted();
        if(adjustment&&'status' in adjustment){
          state.waiting={kind:adjustment.kind,candidate:adjustment.candidate,reason:adjustment.reason,since:new Date().toISOString(),remainingMs:Math.max(0,Date.parse(state.deadlineAt)-Date.now())};
          round.candidate=adjustment.candidate;round.reason=adjustment.reason;
          state.status='WAITING';state.reason=adjustment.reason;delete state.finishedAt;await save();return {status:'STOP'};
        }
        round.candidate=adjustment??undefined;
        if(!round.candidate){finish(hasImprovement()?'REVIEW':'STOPPED','当前入口不具备该诊断所需的调整能力；请在工程迁移任务中继续');return {status:'STOP'};}
        if(round.candidate.digest===working.candidate.digest){round.selected=false;round.reason='候选没有有效变化';await save();return {status:'NEXT_ROUND'};}
        return {status:'READY',value:round.candidate};
      },
      evaluate:async candidate=>{
        await stage('EVALUATION');
        const evaluated=await ports.evaluate(candidate,options);
        round.evaluationId=evaluated.id;
        if(evaluated.candidate.id!==candidate.id||evaluated.candidate.digest!==candidate.digest)throw new Error('复测结果不属于本轮候选');
        if(isResuming&&working.protocolDigest!==evaluated.protocolDigest){
          if(!working.criteriaDigest||working.criteriaDigest!==evaluated.criteriaDigest)throw new Error('恢复后评测标准发生变化，不能沿用原优化目标');
          (state.contextChanges??=[]).push({beforeProtocolDigest:working.protocolDigest,afterProtocolDigest:evaluated.protocolDigest,criteriaDigest:working.criteriaDigest,...resume!.contextChange});
        }
        if(!comparableEvaluations(working,evaluated,state.contextChanges)||!comparableEvaluations(best,evaluated,state.contextChanges))throw new Error('评测未完成或条件发生变化，不能判断改进');
        return evaluated;
      },
      review:async(_candidate,evaluated)=>{
        await stage('REVIEW');
        return ports.review(working,evaluated,round,options,best);
      },
      select:async(_candidate,evaluated,review)=>{
        round.review=review;
        await stage('SELECTION');
        Object.assign(round,selectOptimizationCandidate(working,evaluated,best,review,state.goal.protectedCaseIds,state.contextChanges));
        if(round.selected){best=evaluated;state.best=best.candidate;state.bestEvaluationId=best.id;}
        setWorking(round.selected||round.continued?evaluated:best);
        await ports.activate?.(working);
        state.targetReached=round.selected&&best.cases.filter(c=>c.passed).length/best.cases.length>=state.goal.targetPassRate;
        await save();
        if(state.targetReached){finish('REVIEW','达到目标且独立审查通过，等待人工选择');return true;}
      },
      exhausted:async()=>{
        if(state.status==='RUNNING')finish(hasImprovement()?'REVIEW':'STOPPED',
          working.id!==best.id?'已用完优化轮次；实验版本及待修复问题已保存，最终推荐仍为此前审查认可的版本':'已用完优化轮次；保留已审查的推荐版本');
      },
    });
  }catch(error){finish(signal.aborted?'CANCELLED':'FAILED',error instanceof Error?error.message:String(error));}
  finally{
    clearTimeout(timer);
    if(state.status!=='WAITING')try{await ports.activate?.(best);}catch(error){finish('FAILED',error instanceof Error?error.message:String(error));}
    await save();
  }
  return state;
}
