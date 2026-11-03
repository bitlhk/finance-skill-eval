import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {evaluationPlanSchema} from '../../../evaluation/domain/evaluation-plan.js';
import {canonicalSha256} from '../../../shared/json-canonicalization.js';
import {simpleMigrationCases,simpleMigrationHoldoutCases} from '../../domain/simple-migration-suite.js';
import {evaluateTaskCase} from './evaluate-task-case.js';
import {checkExecutionEvidence} from '../../../evaluation/domain/execution-checks.js';
import type {BundleTask} from '../domain/task-model.js';
import type {BundleJudge} from './task-ports.js';
import {assessmentRepetitionsSchema,assessmentStability,repeatAssessment} from '../../../evaluation/application/repeated-assessment.js';

export const rescoreRequestSchema=z.strictObject({runId:z.string().min(1),
  repetitions:assessmentRepetitionsSchema,
  evaluationPlan:evaluationPlanSchema.optional()});
export async function rescoreTask(task:BundleTask,input:z.input<typeof rescoreRequestSchema>,judge:BundleJudge,signal:AbortSignal){
  const request=rescoreRequestSchema.parse(input);
  const identity=judge.identity?.();
  const attempts=await repeatAssessment(request.repetitions,()=>scoreTaskOnce(task,request,judge,signal),signal);
  if(judge.identity?.()!==identity)throw new Error('Judge configuration changed during repeated assessment');
  return {...attempts[0]!,repetitions:attempts.length,
    ...(attempts.length>1?{attempts,stability:assessmentStability(attempts.map(attempt=>attempt.cases.map(c=>({caseId:c.id,outcome:['PASS','FAIL'].includes(c.status)?c.status:null}))))}:{})};
}
async function scoreTaskOnce(task:BundleTask,input:z.infer<typeof rescoreRequestSchema>,judge:BundleJudge,signal:AbortSignal){
  const source=task.runs.find(run=>run.id===input.runId);
  if(!source||source.status==='RUNNING')throw new Error('Select a finished run to rescore');
  const cases=source.phase==='holdout'?simpleMigrationHoldoutCases(source.suite):simpleMigrationCases(source.suite);
  const judged=[];
  const judgeDigest=judge.identity?.();
  for(const saved of source.cases){
    const original=cases.find(c=>c.caseId===saved.id);
    if(!saved.evidence||!original){judged.push({id:saved.id,status:'UNVERIFIED' as const,reason:'没有可重评的执行证据，请重新运行',methodResults:[]});continue;}
    const evalCase={...original,...(input.evaluationPlan?{evaluationPlan:input.evaluationPlan}:{})};
    const authored=(source.phase==='holdout'?source.suite.holdoutCases:source.suite.cases)?.find(c=>c.id===saved.id);
    const ids=authored?.requirementIds??[];
    if(ids.length&&!source.assessmentRequirements){judged.push({id:saved.id,status:'UNVERIFIED' as const,reason:'旧记录未冻结要求定义，需重新运行',methodResults:[]});continue;}
    // Original execution checks and suite remain frozen; no runtime or business tool is invoked.
    const evaluated=await evaluateTaskCase({evalCase,evidence:saved.evidence,signal,
      executionChecks:saved.executionChecks??checkExecutionEvidence(saved.evidence),judge,judgeInput:{
        requirements:source.assessmentRequirements?.filter(r=>ids.includes(r.id)),
        tools:source.assessmentTools,
      }});
    judged.push({id:saved.id,status:evaluated.incomplete?'UNVERIFIED' as const:evaluated.verdict.passed?'PASS' as const:'FAIL' as const,
      reason:evaluated.verdict.reason,methodResults:evaluated.methodResults,evidenceDigest:canonicalSha256(saved.evidence),
      assessmentVersion:evaluated.verdict.assessmentVersion,criteria:evaluated.verdict.criteria,answerProvenance:evaluated.verdict.answerProvenance,
      ...(evaluated.verdict.investigation?{judgeInvestigation:evaluated.verdict.investigation}:{})});
  }
  if(judge.identity?.()!==judgeDigest)throw new Error('Judge configuration changed during rescoring');
  return {id:'rescore-'+randomUUID(),sourceRunId:source.id,sourceDigest:canonicalSha256(source),
    judgeDigest,plan:input.evaluationPlan,createdAt:new Date().toISOString(),cases:judged};
}
export type TaskRescoring=Awaited<ReturnType<typeof rescoreTask>>;
