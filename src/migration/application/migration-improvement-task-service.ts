import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {EvaluationJob} from '../../shared/contracts/evaluation-job.js';
import type {SkillAssetRecord} from '../../shared/contracts/skill-asset.js';
import {executionConfigurationDigest} from '../../execution-configuration/execution-configuration.js';
import {assessMigrationAcceptance} from '../domain/migration-acceptance.js';
import type {MigrationImprovementTask} from '../domain/migration-improvement-task.js';
import type {TechnicalValidation} from '../domain/migration-model.js';
import type {MigrationProjectStore} from './migration-project-store.js';
import type {MigrationEvaluationJobReader,MigrationEvaluationRunner} from './migration-evaluation-ports.js';
import type {MigrationRuntimeConfigurationRepository} from './migration-runtime-configuration-repository.js';
import type {MigrationImprovementPlanningService} from './migration-improvement-planning-service.js';
import type {MigrationToolOptimizationService} from './migration-tool-optimization-service.js';
import type {MigrationTechnicalValidationWorkflow} from './migration-technical-validation-service.js';
import type {MigrationOpenJiuwenService} from './migration-openjiuwen-service.js';
import type {MigrationOptimizationPort} from './migration-optimization-port.js';
import {migrationConflict as conflict} from './migration-errors.js';
import {resolveMigrationEnvironment,verifyRuntimeReuse,type MigrationEnvironmentRepository} from './migration-environment-repository.js';
import {solutionRevision} from '../domain/migration-solution-revision.js';
import {reusedCapabilitiesDigest} from '../domain/migration-runtime-reuse.js';
import type {MigrationSkillRepository} from './migration-skill-repository.js';
import type {MigrationCandidateInspectionService} from './migration-candidate-inspection-service.js';
import type {MigrationRuntimeRebuildService} from './migration-runtime-rebuild-service.js';
import {currentRuntimeRequirements} from '../domain/migration-runtime-requirements.js';
import {modelRefSchema,fingerprint} from '../../contracts.js';
import {currentReuseProposal} from '../domain/migration-reuse-design.js';
import {ModelCompletionError} from '../../openai-compatible-model.js';

type Dependencies={projects:MigrationProjectStore;jobs:MigrationEvaluationJobReader;runs:MigrationEvaluationRunner;
  configs:MigrationRuntimeConfigurationRepository;planner:MigrationImprovementPlanningService;
  tools:MigrationToolOptimizationService;technical:MigrationTechnicalValidationWorkflow;
  execution:MigrationOpenJiuwenService;optimizers?:MigrationOptimizationPort;environments?:MigrationEnvironmentRepository;
  skills:MigrationSkillRepository;candidateInspection:MigrationCandidateInspectionService;rebuild?:MigrationRuntimeRebuildService;assertReady?:()=>void};

const modelServiceFailed=(job:EvaluationJob)=>job.report?.cases.some(item=>item.right.status==='failed'
  &&/\bEVAL_PACKAGE_MODEL_CALL_FAILED\b/u.test(item.right.error??''))??false;

/** Deterministic guardrails around the model's layer choice; never an automatic deployment approval. */
export class MigrationImprovementTaskService{
  private readonly active=new Map<string,AbortController>();
  private readonly pending=new Map<string,Promise<void>>();
  constructor(private readonly d:Dependencies){}

  async shutdown(){
    for(const controller of this.active.values())controller.abort('SERVICE_SHUTDOWN');
    await Promise.allSettled(this.pending.values());
  }

  async start(id:string,input:unknown){
    this.d.assertReady?.();
    const parsed=z.strictObject({jobId:z.string().min(1),maxIterations:z.number().int().min(1).max(5).default(3),
      maxDurationSeconds:z.number().int().min(60).max(7200).default(1800)}).parse(input);
    const task=await this.d.projects.runExclusive(id,async()=>{
      const project=await this.d.projects.get(id),run=project.runs.find(item=>item.jobId===parsed.jobId),job=this.d.jobs.get(parsed.jobId);
      if(project.reuseAcceptanceResults?.some(item=>item.status==='RUNNING'))return conflict('请先完成或停止复用验收');
      if(project.improvementTasks?.some(item=>['RUNNING','WAITING_BUILDER','WAITING_CONFIGURATION'].includes(item.status)))return conflict('已有改进任务，请先继续或停止该任务');
      if(!project.candidate||!run?.declaredPlan||!run.suiteSnapshot||!run.solutionRevisions?.right
        ||run.candidateDigest!==project.candidate.artifactSha256||job?.status!=='completed'||!job.report?.cases.length)
        return conflict('请先对当前候选完成有方案版本记录的开发集评测');
      if(run.declaredPlan.configuration.evaluationMode!=='candidate_assessment'||run.pair!=='BC')
        return conflict('改进任务需使用已选定的目标验收测试集；跨方案差异不能直接归因');
      if(run.reuseAcceptanceTaskId)return conflict('复用验收运行不能作为自动改进的开发集');
      const reuseProposal=currentReuseProposal(project);
      if(project.reuseProposal&&(!reuseProposal?.approvedAt||run.reuseProposalId!==reuseProposal.proposalId||project.candidateReuseProposalId!==reuseProposal.proposalId))
        return conflict('迁移方案已变化，请先落实当前方案并重新评测');
      if(!run.suiteSnapshot.holdoutCases?.length)return conflict('请先配置独立留出题，再启动改进任务');
      if(run.declaredPlan.configuration.includeHoldout)return conflict('不能使用最终留出集评测作为改进依据');
      if(job.report.cases.some(item=>item.right.status==='completed'&&item.judgeError))
        return conflict('评估服务未能完成基线判定，请先重评；不能把评估服务故障作为改写依据');
      if(modelServiceFailed(job))return conflict('执行模型调用未完成，请先检查模型服务后重测；不能据此改写 Skill、Tool 或 Harness');
      if(project.improvementTasks?.some(item=>item.finalConsumed&&fingerprint(item.frozenSuite.holdoutCases)===fingerprint(run.suiteSnapshot!.holdoutCases)))
        return conflict('这份留出题已经用于最终复核；新一轮改进需准备独立留出题');
      const config=await this.d.configs.get(id);
      const configDigest=executionConfigurationDigest(config,project.sourceInspection?.dependencyAnalysis?.dependencies);
      if(configDigest!==run.runtimeConfigurationDigest)return conflict('运行配置已变化，请先重新评测');
      if(!(await this.d.technical.currentState(project)).ready)return conflict('当前候选的技术验证已失效');
      if(run.declaredPlan.configuration.runtime.type==='runtime_launcher')await verifyRuntimeReuse(project,this.d.environments,run.declaredPlan.configuration.runtime.environmentId);
      const now=Date.now();
      const task:MigrationImprovementTask={taskId:`improve-${randomUUID()}`,sourceJobId:parsed.jobId,
        baseAssetId:project.candidate.assetId,baseCandidateDigest:project.candidate.artifactSha256,
        ...(reuseProposal?.approvedAt?{reuseProposalId:reuseProposal.proposalId}:{}),
        createdAt:new Date(now).toISOString(),deadlineAt:new Date(now+parsed.maxDurationSeconds*1000).toISOString(),
        maxIterations:parsed.maxIterations,status:'RUNNING',stage:'PLANNING',reason:null,
        frozenPlan:structuredClone(run.declaredPlan),frozenSuite:structuredClone(run.suiteSnapshot),configurationDigest:configDigest,
        validationInputsDigest:fingerprint(config.validationInputs??{}),
        ...(project.runtimeDelivery?{originalRuntimeDelivery:structuredClone(project.runtimeDelivery)}:{}),
        bestCandidate:project.candidate,bestJobId:parsed.jobId,bestValidations:project.technicalValidations??[],bestInspection:project.inspection,iterations:[],
        events:[],finalConsumed:false,finalVerified:false};
      (project.improvementTasks??=[]).push(task);
      await this.d.projects.save(project);
      this.active.set(task.taskId,new AbortController());
      return task;
    });
    this.launch(id,task);
    return task;
  }

  async resume(id:string,taskId:string,input:unknown){
    const parsed=z.strictObject({environmentId:z.string().min(1),model:modelRefSchema}).parse(input);
    const task=await this.d.projects.runExclusive(id,async()=>{
      const project=await this.d.projects.get(id),task=project.improvementTasks?.find(item=>item.taskId===taskId);
      if(!task||!['WAITING_BUILDER','WAITING_CONFIGURATION'].includes(task.status)||task.finalConsumed)
        return conflict('仅能继续等待外部交付或配置的任务');
      if(project.candidate?.assetId!==task.baseAssetId||project.candidate.artifactSha256!==task.baseCandidateDigest)
        return conflict('当前候选已由其他操作改变');
      const environment=await resolveMigrationEnvironment(this.d.environments,parsed.environmentId);
      if(!environment)return conflict('请选择可用的 Runtime Launcher');
      if(task.status==='WAITING_BUILDER'){
        const requirements=task.runtimeRequirements,delivery=project.runtimeDelivery;
        if(!requirements||!delivery||delivery.requirementsDigest!==requirements.requirementsDigest
          ||delivery.environmentId!==parsed.environmentId||environment.launcher.delivery?.resultDigest!==delivery.resultDigest
          ||delivery.artifactSha256===requirements.rebuild?.baseline.artifactSha256
          ||delivery.deploymentId===requirements.rebuild?.baseline.deploymentId)
          return conflict('请先接入与本任务需求匹配、通过协议验收的新 Builder 交付');
      }
      const c=task.frozenPlan.configuration;
      c.runtime={type:'runtime_launcher',environmentId:parsed.environmentId};
      c.runtimeBindings={left:{environmentId:parsed.environmentId,skillAssetId:task.bestCandidate.assetId},right:{environmentId:parsed.environmentId,skillAssetId:task.bestCandidate.assetId}};
      c.executionModel=parsed.model;delete c.leftExecutionModel;delete c.rightExecutionModel;
      task.configurationDigest=executionConfigurationDigest(await this.d.configs.get(id),project.sourceInspection?.dependencyAnalysis?.dependencies);
      task.validationInputsDigest=fingerprint((await this.d.configs.get(id)).validationInputs??{});
      task.pendingRuntimeFingerprint=solutionRevision({asset:task.bestCandidate,side:'right',configuration:c,configurationDigest:task.configurationDigest,environment,verifiedCapabilitiesDigest:reusedCapabilitiesDigest(project,environment)}).bindingFingerprint;
      (task.contextChanges??=[]).push({at:new Date().toISOString(),environmentId:parsed.environmentId,modelId:parsed.model.modelId,configurationDigest:task.configurationDigest});
      task.deadlineAt=new Date(Date.now()+(task.remainingDurationMs??0)).toISOString();
      task.rebaselinePending=true;task.status='RUNNING';task.stage='TECHNICAL';task.reason=null;
      await this.d.projects.save(project);this.active.set(taskId,new AbortController());return task;
    });
    this.launch(id,task);return task;
  }

  async list(id:string){
    return this.d.projects.runExclusive(id,async()=>{
      const project=await this.d.projects.get(id);let changed=false;
      for(const task of project.improvementTasks??[]){
        if(task.status==='RUNNING'&&!this.active.has(task.taskId)){
          task.status='INTERRUPTED';task.reason='服务已重启，未自动重复执行未确认的模型或评测动作';task.stage='STOPPED';changed=true;
          this.restoreOriginalDelivery(project,task);
        }
      }
      if(changed)await this.d.projects.save(project);
      return project.improvementTasks??[];
    });
  }

  async cancel(id:string,taskId:string){
    const task=(await this.d.projects.get(id)).improvementTasks?.find(item=>item.taskId===taskId);
    if(!task)return conflict('改进任务不存在');
    if(['ADOPTED','CANCELLED'].includes(task.status))return task;
    task.status='CANCELLED';task.stage='STOPPED';task.reason='用户已停止，原候选保持不变';
    await this.save(id,task);this.active.get(taskId)?.abort();
    await this.cleanup(task);return task;
  }

  async adopt(id:string,taskId:string){
    return this.d.projects.runExclusive(id,async()=>{
      const project=await this.d.projects.get(id),task=project.improvementTasks?.find(item=>item.taskId===taskId);
      if(!task||task.status!=='REVIEW'||!task.finalVerified)return conflict('只有完成最终留出集复核的任务才能采用');
      await this.guard(id,task,undefined,false);
      if(task.frozenPlan.configuration.runtime.type==='runtime_launcher')await verifyRuntimeReuse(project,this.d.environments,task.frozenPlan.configuration.runtime.environmentId);
      const technical=await this.d.technical.currentState({...project,candidate:task.bestCandidate,technicalValidations:task.bestValidations});
      if(!technical.ready)return conflict('候选技术验证已失效，请重新验证');
      project.candidate=task.bestCandidate;
      project.inspection=task.bestInspection;
      // A passing baseline can be adopted unchanged. Copying its choices onto the
      // same asset duplicates them and invalidates the approved proposal digest.
      if(task.bestCandidate.assetId!==task.baseAssetId){
        const carried=(project.decisions??[]).filter(item=>item.baseAssetId===task.baseAssetId)
          .map(item=>({...item,baseAssetId:task.bestCandidate.assetId,decidedAt:new Date().toISOString()}));
        project.decisions=[...(project.decisions??[]).filter(item=>item.baseAssetId!==task.bestCandidate.assetId),...carried];
      }
      project.candidateNotes=`改进任务 ${task.taskId}：开发集与最终留出集复核通过`;
      project.technicalValidations=[...(project.technicalValidations??[]),...task.bestValidations];
      (project.candidateHistory??=[]).push({asset:task.bestCandidate,notes:project.candidateNotes,recordedAt:new Date().toISOString(),kind:'optimization'});
      task.status='ADOPTED';task.reason='已选择此候选；不代表发布到生产环境';
      await this.d.projects.save(project);return task;
    });
  }

  private launch(id:string,task:MigrationImprovementTask){
    const controller=this.active.get(task.taskId)??new AbortController();this.active.set(task.taskId,controller);
    let timedOut=false;
    const deadline=setTimeout(()=>{timedOut=true;controller.abort();void this.cleanup(task);},Math.max(1,Date.parse(task.deadlineAt)-Date.now()));
    const operation=this.run(id,task,controller.signal).catch(async(error:unknown)=>{
      task.status=controller.signal.reason==='SERVICE_SHUTDOWN'?'INTERRUPTED':timedOut?'EXHAUSTED':controller.signal.aborted?'CANCELLED':'FAILED';
      task.stage='STOPPED';task.reason=controller.signal.aborted&&!timedOut?'用户已停止，原候选保持不变'
        :task.status==='EXHAUSTED'?'已达到时间上限，保留此前版本与试验记录':'本轮未能完成，原候选保持不变；请查看对应评测与技术验证记录';
      if(task.status==='INTERRUPTED')task.reason='服务已停止，任务已中断；不会自动重放未确认的动作';
      if(!controller.signal.aborted){
        // Never persist arbitrary provider errors: URLs, headers or credentials may be embedded.
        const modelLabels={MODEL_HTTP_ERROR:'模型服务请求失败',MODEL_NETWORK_ERROR:'模型服务网络请求失败',MODEL_OUTPUT_TRUNCATED:'模型输出达到长度上限',MODEL_EMPTY_RESPONSE:'模型未返回最终答案'} as const;
        const modelCode=error instanceof ModelCompletionError&&Object.hasOwn(modelLabels,error.code)?error.code:undefined;
        const detail=modelCode?`${modelLabels[modelCode]}（${modelCode}）`:error instanceof z.ZodError?`模型或请求字段不符合约定：${error.issues.map(issue=>issue.path.join('.')).slice(0,8).join('、')}`
          :error instanceof Error&&(error as {statusCode?:number}).statusCode===409?error.message:'模型或验证步骤未完成';
        task.reason+=`。${detail}`;
        task.events.push({sequence:task.events.length+1,at:new Date().toISOString(),stage:'STOPPED',message:task.reason});
      }
      await this.cleanup(task);
      await this.save(id,task);
    }).catch(()=>{/* A storage outage is recovered as INTERRUPTED on the next read. */})
      .finally(()=>{clearTimeout(deadline);this.active.delete(task.taskId);this.pending.delete(task.taskId);});
    this.pending.set(task.taskId,operation);
  }

  private async cleanup(task:MigrationImprovementTask){
    await Promise.allSettled([task.activeJobId?this.d.runs.cancel?.(task.activeJobId):undefined,
      task.activeOptimizationId?this.d.optimizers?.decide?.(task.activeOptimizationId,'cancel'):undefined]);
  }

  private async save(id:string,task:MigrationImprovementTask){
    await this.d.projects.runExclusive(id,async()=>{
      const project=await this.d.projects.get(id),index=project.improvementTasks?.findIndex(item=>item.taskId===task.taskId)??-1;
      if(index<0)return conflict('改进任务不存在');
      // A completed model request cannot resurrect a user-cancelled task.
      if(project.improvementTasks![index]!.status==='CANCELLED'){
        task.status='CANCELLED';task.stage='STOPPED';task.reason=project.improvementTasks![index]!.reason;return;
      }
      this.restoreOriginalDelivery(project,task);
      project.improvementTasks![index]=structuredClone(task);await this.d.projects.save(project);
    });
  }

  private restoreOriginalDelivery(project:Awaited<ReturnType<MigrationProjectStore['get']>>,task:MigrationImprovementTask){
    if(['FAILED','EXHAUSTED','CANCELLED','INTERRUPTED'].includes(task.status)&&task.runtimeRequirements
      &&project.candidate?.assetId===task.baseAssetId&&project.runtimeDelivery?.requirementsDigest===task.runtimeRequirements.requirementsDigest){
      if(task.originalRuntimeDelivery)project.runtimeDelivery=structuredClone(task.originalRuntimeDelivery);
      else delete project.runtimeDelivery;
    }
  }

  private async event(id:string,task:MigrationImprovementTask,stage:MigrationImprovementTask['stage'],message:string){
    task.stage=stage;task.events.push({sequence:task.events.length+1,at:new Date().toISOString(),stage,message,
      ...(task.activeJobId?{jobId:task.activeJobId}:{})});await this.save(id,task);
  }

  private async guard(id:string,task:MigrationImprovementTask,signal?:AbortSignal,enforceDeadline=true){
    signal?.throwIfAborted();
    if(task.status==='CANCELLED')throw new Error('cancelled');
    if(enforceDeadline&&Date.now()>=Date.parse(task.deadlineAt))throw new Error('deadline');
    const project=await this.d.projects.get(id);
    if(project.reuseProposal||task.reuseProposalId){
      const proposal=currentReuseProposal(project);
      if(!proposal?.approvedAt||proposal.proposalId!==task.reuseProposalId||project.candidateReuseProposalId!==proposal.proposalId)
        return conflict('任务基于的迁移方案已变化，不能继续或采用');
    }
    if(project.candidate?.assetId!==task.baseAssetId||project.candidate.artifactSha256!==task.baseCandidateDigest)
      return conflict('当前候选已由其他操作改变');
    if(executionConfigurationDigest(await this.d.configs.get(id),project.sourceInspection?.dependencyAnalysis?.dependencies)!==task.configurationDigest)
      return conflict('运行配置已改变');
    if(task.validationInputsDigest&&fingerprint((await this.d.configs.get(id)).validationInputs??{})!==task.validationInputsDigest)
      return conflict('工具测试参数已改变');
    if(task.rebaselinePending&&this.d.environments){
      const runtime=task.frozenPlan.configuration.runtime;
      const environment=runtime.type==='runtime_launcher'?await resolveMigrationEnvironment(this.d.environments,runtime.environmentId):null;
      if(!environment||solutionRevision({asset:task.bestCandidate,side:'right',configuration:task.frozenPlan.configuration,
        configurationDigest:task.configurationDigest,environment,verifiedCapabilitiesDigest:reusedCapabilitiesDigest(project,environment)}).bindingFingerprint!==task.pendingRuntimeFingerprint)
        return conflict('待复核的 Launcher 交付或地址已变化');
    }
    const run=project.runs.find(item=>item.jobId===task.bestJobId),recorded=run?.solutionRevisions?.right;
    if(!task.rebaselinePending&&this.d.environments&&run?.declaredPlan&&recorded){
      const environment=await resolveMigrationEnvironment(this.d.environments,recorded.runtime.environmentId);
      const current=environment?solutionRevision({asset:task.bestCandidate,side:'right',configuration:run.declaredPlan.configuration,
        configurationDigest:task.configurationDigest,environment,verifiedCapabilitiesDigest:reusedCapabilitiesDigest(project,environment)}):null;
      if(!current||current.revisionId!==recorded.revisionId||current.bindingFingerprint!==recorded.bindingFingerprint)
        return conflict('基线 Launcher、模型或运行绑定已变化');
    }
  }

  private score(task:MigrationImprovementTask,job:EvaluationJob,final=false){
    const selected=task.frozenPlan.configuration.selectedCaseIds;
    const definitions=[...task.frozenSuite.cases.filter(item=>!selected.length||selected.includes(item.caseId)),
      ...(final?task.frozenSuite.holdoutCases??[]:[])];
    const variant=job.configuration.rightVariant;
    const verified=job.status==='completed'&&variant?.mode==='skill_version'&&!!job.report?.cases.length
      &&job.report.cases.every(item=>item.right.status==='completed'&&item.right.metadata.skillArtifactSha256===variant.artifactSha256);
    const passed=new Set(definitions.filter(definition=>{
      const result=job.report?.cases.filter(item=>item.caseId===definition.caseId)??[];
      const caseVerified=job.status==='completed'&&variant?.mode==='skill_version'&&result.length===1
        &&result[0]!.right.status==='completed'&&result[0]!.right.metadata.skillArtifactSha256===variant.artifactSha256;
      return result.length===1&&assessMigrationAcceptance({...job.report!,cases:result},[definition],caseVerified).status==='PASSED';
    }).map(item=>item.caseId));
    const all=assessMigrationAcceptance(job.report,definitions,verified).status==='PASSED';
    return {passed,all,total:definitions.length};
  }

  private async waitJob(id:string,task:MigrationImprovementTask,signal:AbortSignal){
    while(true){
      await this.guard(id,task,signal);
      const job=this.d.jobs.get(task.activeJobId!);
      if(!job||['failed','cancelled','interrupted'].includes(job.status))throw new Error('evaluation_failed');
      if(job.status==='completed'){delete task.activeJobId;return job;}
      await new Promise(resolve=>setTimeout(resolve,500));
    }
  }

  private async evaluate(id:string,task:MigrationImprovementTask,candidate:SkillAssetRecord,validations:TechnicalValidation[],signal:AbortSignal,final=false){
    await this.guard(id,task,signal);
    const plan=structuredClone(task.frozenPlan),c=plan.configuration;
    const variant={mode:'skill_version' as const,skillId:candidate.skillId,version:candidate.version,artifactSha256:candidate.artifactSha256};
    c.leftVariant=variant;c.rightVariant=variant;c.skillAssetId=candidate.assetId;c.includeHoldout=final;
    c.runtimeBindings={left:{...c.runtimeBindings!.left,skillAssetId:candidate.assetId},right:{...c.runtimeBindings!.right,skillAssetId:candidate.assetId}};
    for(let attempt=0;attempt<2;attempt++){
      await this.guard(id,task,signal);
      const result=await this.d.execution.validateExperiment(id,plan,{candidate,expectedPackFingerprint:task.frozenSuite.packFingerprint,
        frozenSuite:task.frozenSuite,finalVerification:final,...(task.runtimeRequirements?{runtimeRequirements:task.runtimeRequirements}:{})},validations);
      task.activeJobId=result.job.jobId;if(final)task.finalJobId=result.job.jobId;
      await this.event(id,task,final?'FINAL_VERIFYING':'EVALUATING',final?'正在进行一次性留出集复核':attempt?'评估服务未完成判定，原样重试一次开发集；不修改候选':'正在使用冻结开发集验证独立候选');
      const job=await this.waitJob(id,task,signal);
      if(modelServiceFailed(job))return conflict('执行模型调用未完成，已停止改写并保留候选；请检查模型服务。不会自动重放可能产生副作用的 case');
      if(!job.report?.cases.some(item=>item.right.status==='completed'&&item.judgeError))return job;
      if(final||attempt)return conflict('评估服务未能完成判定；这不是候选业务退化证据，不继续改写。最终留出题不会重跑');
    }
    throw new Error('evaluation_unavailable');
  }

  private async run(id:string,task:MigrationImprovementTask,signal:AbortSignal){
    let noImprovement=0;
    if(task.rebaselinePending){
      await this.event(id,task,'TECHNICAL','外部配置已更新，正在重新验证工具与冻结开发集');
      const project=await this.d.projects.get(id),validations:TechnicalValidation[]=[];
      for(const tool of task.bestInspection?.tools??project.inspection?.tools??[]){
        await this.guard(id,task,signal);validations.push(await this.d.technical.validateIsolated(id,task.bestCandidate,tool.toolId,signal));
      }
      if(validations.some(item=>item.status!=='PASSED'))throw new Error('technical_failed');
      const previous=this.d.jobs.get(task.bestJobId);if(!previous)throw new Error('baseline_missing');
      const before=this.score(task,previous),job=await this.evaluate(id,task,task.bestCandidate,validations,signal);
      const after=this.score(task,job),iteration=task.iterations.at(-1)!;
      iteration.jobId=job.jobId;iteration.passed=after.passed.size;iteration.total=after.total;
      const better=[...before.passed].every(caseId=>after.passed.has(caseId))&&after.passed.size>before.passed.size;
      iteration.outcome=better?'PROMOTED':'RETAINED';
      if(!better){task.status='EXHAUSTED';task.reason='新的 Runtime 或配置未产生可验证的提升；原候选保持不变';await this.event(id,task,'STOPPED',task.reason);return;}
      task.bestJobId=job.jobId;task.bestValidations=validations;task.rebaselinePending=false;await this.save(id,task);
    }
    while(true){
      await this.guard(id,task,signal);
      const baseline=this.d.jobs.get(task.bestJobId);
      if(!baseline)throw new Error('baseline_missing');
      const score=this.score(task,baseline);
      if(score.all){
        if(task.finalConsumed)throw new Error('holdout_already_consumed');
        task.finalConsumed=true;await this.save(id,task);
        const finalJob=await this.evaluate(id,task,task.bestCandidate,task.bestValidations,signal,true);
        task.finalVerified=this.score(task,finalJob,true).all;
        task.status=task.finalVerified?'REVIEW':'FAILED';task.reason=task.finalVerified?'开发集与留出集通过，等待选择候选':'最终留出集未通过；不会将留出题反馈给模型继续改写';
        await this.event(id,task,'STOPPED',task.reason);return;
      }
      if(task.iterations.length>=task.maxIterations||noImprovement>=2){
        task.status='EXHAUSTED';task.reason=noImprovement>=2?'连续两轮没有可验证的提升，保留此前版本':'已达到改进轮次上限，保留此前版本';
        await this.event(id,task,'STOPPED',task.reason);return;
      }
      await this.event(id,task,'PLANNING','正在根据开发集证据定位问题');
      const plan=await this.d.planner.propose(id,{jobId:task.bestJobId},task.bestCandidate,
        task.iterations.map(({layer,outcome,passed,total})=>({layer,outcome,passed,total})),signal,task.iterations.length===0);
      await this.guard(id,task,signal);
      if(plan.status==='ABSTAINED'||!plan.hypothesis){task.status='FAILED';task.reason=plan.abstainReason??'证据不足，未修改候选';await this.event(id,task,'STOPPED',task.reason);return;}
      const layer=plan.hypothesis.layer;
      const iteration:MigrationImprovementTask['iterations'][number]={iteration:task.iterations.length+1,planId:plan.planId,layer,outcome:'PENDING'};
      task.iterations.push(iteration);await this.save(id,task);
      if(!['SKILL','TOOL'].includes(layer)){
        if(layer==='HARNESS'&&this.d.rebuild){
          const existing=currentRuntimeRequirements(await this.d.projects.get(id));
          const capabilities=plan.hypothesis.requiredCapabilities??(existing&&'requiredCapabilities' in existing?existing.requiredCapabilities:[]);
          if(capabilities.length)task.runtimeRequirements=await this.d.rebuild.propose(id,{planId:plan.planId,requiredCapabilities:capabilities},task.bestCandidate);
        }
        task.remainingDurationMs=Math.max(0,Date.parse(task.deadlineAt)-Date.now());
        task.status=layer==='HARNESS'?'WAITING_BUILDER':layer==='CONFIGURATION'?'WAITING_CONFIGURATION':'FAILED';
        task.reason=layer==='HARNESS'?(task.runtimeRequirements?'需要新的 Builder 交付；可在 Runtime 适配页下载需求并导入结果，再继续本任务':'缺少可核验的 Runtime 能力合同；已保存证据，需补齐合同后重新规划，不能直接部署')
          :layer==='CONFIGURATION'?'需要补充或修正运行配置；不会让模型猜测凭据':'需确认测试方案或补充证据，不自动改变验收要求';
        await this.event(id,task,'STOPPED',task.reason);return;
      }
      await this.event(id,task,'IMPLEMENTING',layer==='TOOL'?'正在生成独立 Tool 修复候选':'正在生成独立 Skill 修复候选');
      let candidate:SkillAssetRecord,validations:TechnicalValidation[];
      if(layer==='TOOL'){
        const attempt=await this.d.tools.propose(id,{planId:plan.planId},task.bestCandidate,signal);
        iteration.attemptId=attempt.attemptId;candidate=attempt.candidate;validations=[...attempt.validations];
        iteration.changedPaths=[...attempt.changedPaths];iteration.summary=attempt.summary;
      }else{
        if(!this.d.optimizers?.propose)throw new Error('optimizer_unavailable');
        const proposalProject=await this.d.projects.get(id);
        let optimization=await this.d.optimizers.propose(task.bestJobId,proposalProject.reuseProposal?.approvedAt?JSON.stringify(proposalProject.reuseProposal.design):undefined);
        task.activeOptimizationId=optimization.optimizationId;iteration.optimizationId=optimization.optimizationId;await this.save(id,task);
        while(['diagnosing','validating'].includes(optimization.status)){
          await this.guard(id,task,signal);await new Promise(resolve=>setTimeout(resolve,500));
          optimization=await this.d.optimizers.get(optimization.optimizationId);
        }
        delete task.activeOptimizationId;
        if(optimization.status!=='review'||!optimization.candidate)throw new Error('proposal_failed');
        candidate=optimization.candidate;
        iteration.changedPaths=optimization.changes.map(change=>change.path);iteration.summary=optimization.summary;
        validations=[];await this.event(id,task,'TECHNICAL','正在逐个验证候选 Tool，当前候选不变');
        const project=await this.d.projects.get(id);
        for(const tool of project.inspection?.tools??[]){await this.guard(id,task,signal);validations.push(await this.d.technical.validateIsolated(id,candidate,tool.toolId,signal));}
      }
      iteration.candidateAssetId=candidate.assetId;
      await this.guard(id,task,signal);
      const current=await this.d.projects.get(id);
      const sourceFiles:Record<string,string>={};
      if(current.reuseProposal)Object.assign(sourceFiles,await this.d.candidateInspection.sourceFiles(current));
      const candidateInspection=await this.d.candidateInspection.inspect({candidate,files:await this.d.skills.readArchive(candidate.assetId),
        inspection:current.inspection!,decisions:current.decisions??[],baseAssetId:task.baseAssetId,generations:current.portableGenerations??[],
        reuseProposal:current.reuseProposal,sourceInspection:current.sourceInspection??current.inspection,sourceFiles});
      if(validations.some(item=>item.status!=='PASSED')){
        iteration.outcome='TECHNICAL_FAILED';noImprovement++;await this.save(id,task);continue;
      }
      const job=await this.evaluate(id,task,candidate,validations,signal);
      iteration.jobId=job.jobId;
      const revised=this.score(task,job);iteration.passed=revised.passed.size;iteration.total=revised.total;
      const better=[...score.passed].every(caseId=>revised.passed.has(caseId))&&revised.passed.size>score.passed.size;
      iteration.outcome=better?'PROMOTED':'RETAINED';
      if(better){task.bestCandidate=candidate;task.bestJobId=job.jobId;task.bestValidations=validations;task.bestInspection=candidateInspection;noImprovement=0;}
      else noImprovement++;
      await this.event(id,task,'EVALUATING',better?'候选有可验证的提升，进入下一步检查':'候选未提升或出现回退，保留此前版本');
    }
  }
}
