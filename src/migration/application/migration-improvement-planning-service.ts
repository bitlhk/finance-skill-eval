import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { improvementHypothesisSchema, type MigrationImprovementPlan } from '../domain/migration-improvement-plan.js';
import type { MigrationEvaluationJobReader } from './migration-evaluation-ports.js';
import type { MigrationProjectStore } from './migration-project-store.js';
import { migrationConflict as conflict } from './migration-errors.js';
import type {MigrationRuntimeConfigurationRepository} from './migration-runtime-configuration-repository.js';
import {validateDependencyData} from '../domain/migration-dependency-schema.js';
import type {SkillAssetRecord} from '../../shared/contracts/skill-asset.js';
import type {MigrationSkillRepository} from './migration-skill-repository.js';
import {currentRuntimeRequirements} from '../domain/migration-runtime-requirements.js';

export const improvementJudgementSchema=z.discriminatedUnion('status',[
  z.strictObject({status:z.literal('PROPOSED'),hypothesis:improvementHypothesisSchema}),
  z.strictObject({status:z.literal('ABSTAINED'),reason:z.string().min(1).max(2000)}),
]);
export type ImprovementJudgement=z.infer<typeof improvementJudgementSchema>;
/** Safe planning diagnostics; never carries raw model output or provider text. */
export class ImprovementPlanningError extends Error{
  readonly statusCode=409;
  constructor(readonly fields:string[],readonly code:'MODEL_OUTPUT_INVALID'|'MODEL_CORRECTION_CHANGED_FACTS'='MODEL_OUTPUT_INVALID'){
    super(`${code==='MODEL_CORRECTION_CHANGED_FACTS'?'纠错结果改变了原始判断或证据':'优化规划结果不符合约定'}（${code}）${fields.length?`：${fields.join('；')}`:''}`);
  }
}
export type ImprovementPlanningInput={
  modelId:string;
  sourceJobId:string;
  baseSolutionRevisionId:string;
  tools:Array<{toolId:string;name:string;form:string}>;
  runtimeConfiguration:Array<{dependencyId:string;key:string;provided:boolean;valid:boolean;sensitive:boolean}>;
  technicalEvidence:Array<{toolId:string;status:string;stages:Array<{name:string;passed:boolean}>}>;
  cases:Array<{caseId:string;task:string;runtimeStatus:string;runtimeErrorCode?:string;
    runtimeIdentityVerified:boolean;streamCompleted:boolean;toolTraceStatus:'COMPLETE'|'PARTIAL_OR_UNAVAILABLE';
    executionBudget?:{maxAgentIterations:number;owner?:'HARNESS';changeMechanism?:'BUILDER_REBUILD'};
    toolCalls:Array<{name:string;status:string}>;review:string|null;verdict:string|null}>;
  previousExperiments?:Array<{layer:string;outcome:string;passed?:number;total?:number}>;
  codeEvidence?:Array<{origin:'source'|'candidate';path:string;content:string}>;
  runtimeEvidence?:Array<{path:string;content:string}>;
  runtimeRequirements?:unknown;
  approvedReuseDesign?:import('../domain/migration-reuse-design.js').ReuseDesign;
};
export type ImprovementPlanner=(input:ImprovementPlanningInput,signal?:AbortSignal)=>Promise<unknown>;
const MAX_PLANS_PER_CANDIDATE=5;
function stableRuntimeErrorCode(error:string|null|undefined):string|undefined{
  if(!error)return undefined;
  if(/^[A-Za-z0-9_.-]{1,100}$/u.test(error))return error;
  return error.match(/\bEVAL_[A-Z0-9_]{1,90}\b/u)?.[0];
}

/** Grounds a model hypothesis in development cases; it never mutates a candidate by itself. */
export class MigrationImprovementPlanningService {
  constructor(private readonly projects:MigrationProjectStore,private readonly jobs:MigrationEvaluationJobReader,
    private readonly planner:ImprovementPlanner,private readonly modelId:()=>string,
    private readonly runtimeConfigs?:MigrationRuntimeConfigurationRepository,private readonly skills?:MigrationSkillRepository){}

  async propose(id:string,input:unknown,experimentCandidate?:SkillAssetRecord,previousExperiments?:ImprovementPlanningInput['previousExperiments'],signal?:AbortSignal):Promise<MigrationImprovementPlan>{
    signal?.throwIfAborted();
    const {jobId}=z.strictObject({jobId:z.string().min(1)}).parse(input);
    const stored=await this.projects.get(id),project={...stored,candidate:experimentCandidate??stored.candidate};
    const run=project.runs.find(item=>item.jobId===jobId),job=this.jobs.get(jobId);
    const activeDigest=stored.candidate?.artifactSha256;
    if(!project.candidate||!run||run.candidateDigest!==project.candidate.artifactSha256||!run.solutionRevisions?.right
      ||job?.status!=='completed'||!job.report?.cases.length||!run.suiteSnapshot)return conflict('请先对当前候选完成可追溯的开发集评测');
    if(run.reuseAcceptanceTaskId)return conflict('复用验收运行不能作为自动改进的开发集');
    if(run.declaredPlan?.configuration.includeHoldout)return conflict('最终留出集不能作为改进规划依据');
    if((project.improvementPlans??[]).filter(item=>item.candidateDigest===project.candidate?.artifactSha256).length>=MAX_PLANS_PER_CANDIDATE)
      return conflict('当前候选已达到改进规划次数上限；请先验证或处理已有假设');
    const holdoutIds=new Set((run.suiteSnapshot.holdoutCases??[]).map(item=>item.caseId));
    const allowed=new Set(run.suiteSnapshot.cases.filter(item=>!holdoutIds.has(item.caseId)).map(item=>item.caseId));
    const selected=run.declaredPlan?.configuration.selectedCaseIds??[];
    const cases=job.report.cases.filter(item=>allowed.has(item.caseId)&&(!selected.length||selected.includes(item.caseId)));
    if(!cases.length)return conflict('本轮没有可用于改进规划的开发案例；留出题不会发送给规划模型');
    const modelId=this.modelId(),baseSolutionRevisionId=run.solutionRevisions.right.revisionId;
    const codeEvidence:NonNullable<ImprovementPlanningInput['codeEvidence']>=[];let remaining=80000;
    if(this.skills){
      for(const [origin,asset,inspection] of [['candidate',project.candidate,project.inspection],['source',project.source,project.sourceInspection]] as const){
        if(!asset)continue;
        const archive=await this.skills.readArchive(asset.assetId);
        const paths=[asset.skillFile,...new Set(inspection?.tools.flatMap(tool=>tool.sourcePaths)??[])];
        for(const path of paths){
          if(!archive[path]||!remaining||!/\.(?:md|py|java|js|mjs|cjs|ts|json|toml|ya?ml)$/iu.test(path))continue;
          let content:string;try{content=new TextDecoder('utf-8',{fatal:true}).decode(archive[path])}catch{continue;}
          content=content.slice(0,Math.min(remaining,12000));remaining-=content.length;
          codeEvidence.push({origin,path,content});
        }
      }
    }
    const config=this.runtimeConfigs?await this.runtimeConfigs.get(id):null;
    const technicalEvidence=[...(project.technicalValidations??[]),...(project.toolOptimizationAttempts??[]).flatMap(item=>item.validations),
      ...(project.improvementTasks??[]).flatMap(item=>item.bestValidations)]
      .filter(item=>item.assetDigest===project.candidate!.artifactSha256
        &&(!item.runtimeConfigurationDigest||item.runtimeConfigurationDigest===run.runtimeConfigurationDigest))
      .filter((item,index,all)=>!all.slice(index+1).some(value=>value.toolId===item.toolId))
      .map(item=>({toolId:item.toolId,status:item.status,stages:item.stages.map(stage=>({name:stage.name,passed:stage.passed}))}));
    const runtimeConfiguration=(project.sourceInspection?.dependencyAnalysis?.dependencies??[])
      .filter(item=>item.owner==='RUNTIME'&&item.action==='INJECT').map(item=>{
        const provided=!!config&&Object.prototype.hasOwnProperty.call(config.values,item.id);
        return {dependencyId:item.id,key:item.key,provided,valid:provided&&!validateDependencyData(config!.values[item.id],item.schema).length,
          sensitive:item.sensitive};
      });
    // Line-addressable documents derived only from this frozen development run.
    // They are telemetry evidence, not invented Skill source or holdout content.
    const runtimeEvidence=cases.map(item=>({path:`runtime-evidence/${encodeURIComponent(jobId)}/${encodeURIComponent(item.caseId)}.json`,
      content:JSON.stringify({jobId,caseId:item.caseId,status:item.right.status,
        ...(stableRuntimeErrorCode(item.right.error)?{runtimeErrorCode:stableRuntimeErrorCode(item.right.error)}:{}),
        ...this.executionBudget(item.right.metadata),runtimeIdentityVerified:item.right.runtimeIdentityVerified===true,
        streamCompleted:item.right.streamCompleted===true,toolCalls:item.right.toolCalls.map(call=>({name:call.name,status:call.status})).slice(0,30)},null,2)}));
    const modelResponse=await this.planner({modelId,sourceJobId:jobId,baseSolutionRevisionId,
      tools:(project.inspection?.tools??[]).map(tool=>({toolId:tool.toolId,name:tool.name,form:tool.kind})),
      runtimeConfiguration,
      technicalEvidence,
      codeEvidence,runtimeEvidence,runtimeRequirements:currentRuntimeRequirements(project),
      ...(project.reuseProposal?.approvedAt?{approvedReuseDesign:project.reuseProposal.design}:{}),
      ...(previousExperiments?{previousExperiments}:{}),
      cases:cases.map(item=>({caseId:item.caseId,task:item.prompt.slice(0,4000),runtimeStatus:item.right.status,
        ...this.executionBudget(item.right.metadata),
        runtimeIdentityVerified:item.right.runtimeIdentityVerified===true,streamCompleted:item.right.streamCompleted===true,
        toolTraceStatus:item.right.status==='completed'&&item.right.runtimeIdentityVerified&&item.right.streamCompleted?'COMPLETE':'PARTIAL_OR_UNAVAILABLE',
        ...(stableRuntimeErrorCode(item.right.error)?{runtimeErrorCode:stableRuntimeErrorCode(item.right.error)}:{}),
        toolCalls:item.right.toolCalls.map(call=>({name:call.name,status:call.status})).slice(0,30),
        review:item.judge?.summary.slice(0,2000)??null,
        verdict:item.judge?.serviceComparison?.verdict??item.judge?.goalAssessment?.verdict??item.judge?.winner??null}))},signal);
    const correctionSchema=z.strictObject({attempts:z.number().int().min(0).max(2),
      originalDigest:z.string().regex(/^[a-f0-9]{64}$/u),acceptedDigest:z.string().regex(/^[a-f0-9]{64}$/u)});
    const wrapped=modelResponse&&typeof modelResponse==='object'&&'judgement' in modelResponse&&'outputCorrection' in modelResponse
      ?modelResponse as {judgement:unknown;outputCorrection:unknown}:null;
    const correction=wrapped?correctionSchema.parse(wrapped.outputCorrection):null;
    const judgement=improvementJudgementSchema.parse(wrapped?wrapped.judgement:modelResponse);
    signal?.throwIfAborted();
    if(judgement.status==='PROPOSED'&&judgement.hypothesis.requiredCapabilities){
      if(judgement.hypothesis.layer!=='HARNESS')return conflict('只有 Harness 假设能提出 Runtime 能力合同');
      for(const capability of judgement.hypothesis.requiredCapabilities){
        if(!capability.evidence.length||capability.evidence.some(item=>![...codeEvidence,...runtimeEvidence].some(file=>file.path===item.path&&item.line<=file.content.split('\n').length)))
          return conflict('能力合同必须引用本轮提供的源码位置或运行证据位置');
        if(capability.consumerTools.some(toolId=>!project.inspection?.tools.some(tool=>tool.toolId===toolId||tool.name===toolId)))
          return conflict('能力合同引用了不存在的消费者工具');
      }
    }
    if(judgement.status==='PROPOSED'&&judgement.hypothesis.evidenceCaseIds.some(caseId=>!cases.some(item=>item.caseId===caseId)))
      return conflict('改进假设引用了非开发集案例，已拒绝记录');
    if(judgement.status==='PROPOSED'&&judgement.hypothesis.toolIds?.some(toolId=>!project.inspection?.tools.some(tool=>tool.toolId===toolId)))
      return conflict('改进假设引用了不存在的 Tool');
    const plan:MigrationImprovementPlan={planId:`improvement-${randomUUID()}`,sourceJobId:jobId,baseSolutionRevisionId,
      candidateDigest:project.candidate.artifactSha256,developmentCaseIds:cases.map(item=>item.caseId),createdAt:new Date().toISOString(),modelId,
      status:judgement.status,hypothesis:judgement.status==='PROPOSED'?judgement.hypothesis:null,
      abstainReason:judgement.status==='ABSTAINED'?judgement.reason:null,
      ...(correction?{outputCorrection:correction}:{})};
    await this.projects.runExclusive(id,async()=>{
      const current=await this.projects.get(id);
      if(current.candidate?.artifactSha256!==activeDigest)return conflict('规划期间候选已变化，请重新评测');
      if((current.improvementPlans??[]).filter(item=>item.candidateDigest===plan.candidateDigest).length>=MAX_PLANS_PER_CANDIDATE)
        return conflict('当前候选已达到改进规划次数上限');
      (current.improvementPlans??=[]).push(plan);
      await this.projects.save(current);
    });
    return plan;
  }

  private executionBudget(metadata:Record<string,unknown>|undefined){
    const value=z.object({maxAgentIterations:z.number().int().positive().max(100000),owner:z.literal('HARNESS').optional(),
      changeMechanism:z.literal('BUILDER_REBUILD').optional()}).safeParse(metadata?.executionBudget);
    return value.success?{executionBudget:value.data}:{};
  }
}
