import {runDiagnosisInput} from './task-run-analysis.js';
import {randomUUID} from 'node:crypto';
import {canonicalSha256} from '../../../shared/json-canonicalization.js';
import {runOptimizationLoop,type OptimizationResume} from '../../../improvement/application/optimization-loop.js';
import {effectReviewInput} from '../../../improvement/application/review-input.js';
import type {ImprovementAgents} from '../../../improvement/application/improvement-agents.js';
import type {CandidateRef,OptimizationEvaluation,OptimizationLoop} from '../../../improvement/domain/optimization-loop.js';
import {bundleError,currentCandidate,completedRepetitions,type BundleTask,type BundleAttempt,type BundleCandidate,type BundleRun,type BundleSnapshot} from '../domain/task-model.js';
import {conformancePassed} from '../domain/task-standardization.js';
import {simpleMigrationCases} from '../../domain/simple-migration-suite.js';

export function bundleOptimizationEvaluation(task:BundleTask,run:BundleRun):OptimizationEvaluation{
  const authored=simpleMigrationCases(run.suite);
  if(run.phase!=='development')bundleError('留出验收不能进入优化');
  const group=completedRepetitions(task,run);
  return {id:run.id,candidate:{id:run.candidateId,digest:run.candidateDigest},
    criteriaDigest:canonicalSha256({suite:run.suiteDigest,judge:run.judgeDigest??null,plan:task.analysis??null}),
    protocolDigest:canonicalSha256({suite:run.suiteDigest,configuration:run.configurationDigest,judge:run.judgeDigest??null,
      runtime:run.runtimeSnapshot??null,selection:run.runtimeSelectionRevision??null,builder:run.builderBindingId??null,plan:task.planRevisionId??null}),
    cases:authored.map(c=>{const result=run.cases.find(r=>r.id===c.caseId);return {id:c.caseId,
      passed:group?.every(item=>item.cases.some(r=>r.id===c.caseId&&!r.failureStage&&!r.unverified))
        ?group.every(item=>item.cases.find(r=>r.id===c.caseId)!.passed):null,
      observation:{task:c.prompt,criteria:c.rubric,result,...(run.repetition?{repetitions:group?.map(item=>item.cases.find(r=>r.id===c.caseId))}:{})}};})};
}
type Context={
  get():Promise<BundleTask>;
  snapshot(candidateId:string):Promise<BundleSnapshot>;
  save(state:OptimizationLoop):Promise<void>;
  adjust(task:BundleTask,runId:string,diagnosis:unknown,signal:AbortSignal):Promise<BundleCandidate>;
  evaluate(task:BundleTask,signal:AbortSignal):Promise<BundleRun>;
  activate(runId:string):Promise<void>;
};
export async function optimizeMigrationTask(task:BundleTask,attempt:BundleAttempt,context:Context,agents:ImprovementAgents,signal:AbortSignal){
  const initial=task.runs.find(r=>r.id===(attempt.optimization?.baselineEvaluationId??attempt.runId))!;
  const baseline=bundleOptimizationEvaluation(task,initial);
  const goal=attempt.optimizationGoal!;
  const now=Date.now();
  const state:OptimizationLoop=attempt.optimization??{id:'loop-'+randomUUID(),goal,baseline:baseline.candidate,best:baseline.candidate,bestEvaluationId:baseline.id,
    status:'RUNNING',stage:'DIAGNOSIS',rounds:[],createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+goal.maxDurationSeconds*1000).toISOString()};
  const candidateTask=async(ref:CandidateRef)=>({...await context.get(),currentCandidateId:ref.id});
  const resume:OptimizationResume|undefined=state.waiting?{
    working:bundleOptimizationEvaluation(task,task.runs.find(r=>r.id===state.workingEvaluationId)!),
    incumbent:bundleOptimizationEvaluation(task,task.runs.find(r=>r.id===state.bestEvaluationId)!),candidate:state.waiting.candidate,
    contextChange:{reference:state.waiting.requestId??`configuration:${canonicalSha256(task.configuration)}`,reason:state.waiting.reason},
  }:undefined;
  await runOptimizationLoop(state,baseline,{
    save:context.save,
    activate:evaluation=>context.activate(evaluation.id),
    diagnose:async(evaluation,history,options)=>{
      const current=await candidateTask(evaluation.candidate),snapshot=await context.snapshot(evaluation.candidate.id);
      const run=current.runs.find(r=>r.id===evaluation.id)!;
      const result=await agents.diagnose(runDiagnosisInput(current,run,snapshot,{
        baseline:current.runs.find(r=>r.id===state.baselineEvaluationId),goal:state.goal,
        history:history.map(r=>({layer:r.diagnosis?.status==='PROPOSED'?r.diagnosis.hypothesis.layer:'UNKNOWN',outcome:JSON.stringify({reason:r.reason??r.stage,review:r.review})}))}),options);
      if(result.judgement.status==='PROPOSED'&&result.judgement.hypothesis.evidenceCaseIds.some(id=>!evaluation.cases.some(c=>c.id===id)))bundleError('诊断引用了开发集之外的案例');
      if(state.rounds.at(-1))state.rounds.at(-1)!.investigation=result.investigation;
      return result.judgement;
    },
    adjust:async(ref,diagnosis,options)=>{
      if(diagnosis.status!=='PROPOSED')return null;
      const hypothesis=diagnosis.hypothesis;
      let candidate=ref;
      if(['SKILL','TOOL'].includes(hypothesis.layer)||(hypothesis.layer==='HARNESS'&&hypothesis.projectPaths?.length)){
        const files=(await context.snapshot(ref.id)).files;
        if(hypothesis.projectPaths?.some(path=>!(path in files)))bundleError('诊断引用了工程之外的源码文件');
        const adjusted=await context.adjust(await candidateTask(ref),state.workingEvaluationId??state.bestEvaluationId,diagnosis,options.signal!);
        if(task.analysis?.standardization&&!conformancePassed(adjusted.conformance))bundleError('候选未通过独立标准化审查');
        candidate={id:adjusted.id,digest:adjusted.digest};
      }
      if(['SKILL','TOOL'].includes(hypothesis.layer))return candidate;
      const kind=hypothesis.layer==='HARNESS'?'BUILDER':hypothesis.layer==='CONFIGURATION'?'CONFIGURATION':'INPUT';
      return {status:'WAITING',kind,candidate,reason:`${kind==='BUILDER'?'等待 Builder 基于工程代码完成 Runtime 改造':kind==='CONFIGURATION'?'等待补充运行配置':'等待确认诊断所需输入'}：${hypothesis.issue}；验证：${hypothesis.validation}`};
    },
    evaluate:async(ref,options)=>{
      const current=await candidateTask(ref),run=await context.evaluate(current,options.signal!);
      return bundleOptimizationEvaluation(current,run);
    },
    review:async(before,after,round,options,incumbent)=>{
      const current=await candidateTask(after.candidate),candidate=currentCandidate(current)!;
      const [base,next]=await Promise.all([context.snapshot(before.candidate.id),context.snapshot(after.candidate.id)]);
      return agents.review(effectReviewInput(goal.goal,before,after,candidate.diff.map(change=>({path:change.path,reason:change.kind,
        before:Buffer.from(base.files[change.path]??'','base64').toString('utf8').slice(0,12000),after:Buffer.from(next.files[change.path]??'','base64').toString('utf8').slice(0,12000)})),
        {incumbent,protectedCaseIds:goal.protectedCaseIds,targetPassRate:goal.targetPassRate,remainingRounds:goal.maxRounds-round.number,contextChanges:state.contextChanges}),options);
    },
  },signal,resume);
  return state;
}
