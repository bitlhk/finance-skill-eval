import {randomUUID} from 'node:crypto';
import {toolTraceStatus} from '../../../evaluation/domain/runtime-process.js';
import {canonicalSha256} from '../../../shared/json-canonicalization.js';
import type {ImprovementDiagnoser,ImprovementDiagnosisInput} from '../../../improvement/application/diagnosis-port.js';
import {simpleMigrationCases} from '../../domain/simple-migration-suite.js';
import {bundleError,completedRepetitions,type BundleTask,type BundleRun,type BundleSnapshot} from '../domain/task-model.js';

/** Shared by independent reports and optimization. Only development evidence enters diagnosis. */
export function runDiagnosisInput(task:BundleTask,run:BundleRun,snapshot:BundleSnapshot,context:{
  baseline?:BundleRun;goal?:unknown;history?:ImprovementDiagnosisInput['previousExperiments'];
}={}):ImprovementDiagnosisInput{
  if(run.phase!=='development'||run.status==='RUNNING')bundleError('请选择已结束的开发集评测；留出集不进入修改诊断');
  if(snapshot.digest!==run.candidateDigest)bundleError('运行与工程快照不一致');
  const candidate=task.candidates.find(c=>c.id===run.candidateId);
  const group=run.repetition?completedRepetitions(task,run):undefined;
  return {modelId:'diagnosis',sourceJobId:run.id,baseSolutionRevisionId:run.candidateDigest,
    tools:(candidate?.tools??[]).map(t=>({toolId:t.toolId,name:t.toolId,form:t.form})),runtimeConfiguration:[],technicalEvidence:[],
    cases:simpleMigrationCases(run.suite).map(c=>{
      const result=run.cases.find(r=>r.id===c.caseId);
      return {caseId:c.caseId,task:c.prompt,runtimeStatus:result?.evidence?.status??'not_run',
        runtimeIdentityVerified:result?.evidence?.runtimeIdentityVerified??false,streamCompleted:result?.evidence?.streamCompleted??false,
        toolTraceStatus:toolTraceStatus(result?.evidence),
        toolCalls:(result?.evidence?.toolCalls??[]).map(call=>({name:call.name,status:call.status})),review:result?.reason??null,
        verdict:run.repetition?(!group?'UNVERIFIED':group.every(item=>item.cases.find(r=>r.id===c.caseId)?.passed)?'PASS':'FAIL')
          :!result?'NOT_RUN':result.failureStage??(result.unverified?'UNVERIFIED':result.passed?'PASS':'FAIL')};
    }),
    codeEvidence:Object.entries(snapshot.files).filter(([p])=>/\.(md|py|ts|js|json)$/iu.test(p))
      .map(([path,content])=>({origin:'candidate',path,content:Buffer.from(content,'base64').toString('utf8')})),
    evaluationEvidence:{current:run.cases,baseline:context.baseline?.phase==='development'?context.baseline.cases:undefined,
      ...(run.repetition?{repetitions:task.runs.filter(r=>r.repetition?.groupId===run.repetition!.groupId&&r.phase==='development').map(r=>({runId:r.id,repetition:r.repetition,status:r.status,cases:r.cases}))}:{})},
    approvedReuseDesign:{goal:context.goal,requirements:run.assessmentRequirements},previousExperiments:context.history};
}

export async function analyzeSavedRun(task:BundleTask,run:BundleRun,snapshot:BundleSnapshot,diagnose:ImprovementDiagnoser,signal:AbortSignal){
  signal.throwIfAborted();
  const input=runDiagnosisInput(task,run,snapshot);
  const result=await diagnose(input,{requestId:'analysis-'+randomUUID(),signal});
  signal.throwIfAborted();
  if(result.judgement.status==='PROPOSED'&&result.judgement.hypothesis.evidenceCaseIds.some(id=>!input.cases.some(c=>c.caseId===id)))
    bundleError('诊断引用了本次开发集之外的案例');
  return {id:'analysis-'+randomUUID(),sourceRunId:run.id,sourceDigest:canonicalSha256(run),snapshotDigest:snapshot.digest,
    createdAt:new Date().toISOString(),classifications:input.cases.map(c=>({caseId:c.caseId,status:c.verdict})),...result};
}
export type SavedRunAnalysis=Awaited<ReturnType<typeof analyzeSavedRun>>;
