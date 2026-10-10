import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {canonicalSha256} from '../../shared/json-canonicalization.js';
import {executionConfigurationDigest} from '../../execution-configuration/execution-configuration.js';
import {runConfigurationSchema} from '../../shared/contracts/run-configuration.js';
import {currentReuseProposal} from '../domain/migration-reuse-design.js';
import {reuseAcceptancePlanSchema,reuseAcceptancePlanIssues,coverageSchema,reuseAcceptanceVerdictsSchema,type ReuseAcceptanceBinding,type ReuseAcceptanceResult,type ReuseAcceptanceSummary} from '../domain/migration-reuse-acceptance.js';
import {migrationRuntimeCapabilities,verifyRuntimeReuse,type MigrationEnvironmentRepository} from './migration-environment-repository.js';
import type {MigrationReuseAcceptanceModel} from './migration-reuse-acceptance-model.js';
import type {MigrationSkillRepository} from './migration-skill-repository.js';
import type {MigrationProjectStore} from './migration-project-store.js';
import type {MigrationRuntimeConfigurationRepository} from './migration-runtime-configuration-repository.js';
import type {MigrationSuiteService} from './migration-suite-service.js';
import type {MigrationOpenJiuwenService} from './migration-openjiuwen-service.js';
import type {MigrationEvaluationJobReader,MigrationEvaluationRunner} from './migration-evaluation-ports.js';
import {migrationConflict as conflict} from './migration-errors.js';
import {ReuseAcceptanceError} from '../domain/migration-reuse-failure.js';
import {judgeRuntimeEvidence} from '../../judge-runtime-evidence.js';
import {reuseExecutionContract} from '../domain/migration-reuse-execution-contract.js';

const digest=(value:unknown)=>canonicalSha256(JSON.parse(JSON.stringify(value)));
const planIntact=(plan:{binding:unknown;plan:unknown;coverage:unknown;inputDigest:string})=>plan.inputDigest===digest({binding:plan.binding,plan:plan.plan,coverage:plan.coverage});
const selection=z.strictObject({environmentId:z.string().min(1),modelId:z.string().min(1)});
const activeStatuses=['RUNNING','WAITING_BUILDER','WAITING_CONFIGURATION'];
const runtimeFailures:Record<string,{code:string;message:string}>={
  EVAL_PACKAGE_MODEL_CALL_FAILED:{code:'RUNTIME_MODEL_FAILED',message:'Runtime 内的模型调用失败'},
  EVAL_PACKAGE_MODEL_FAILED:{code:'RUNTIME_MODEL_FAILED',message:'Runtime 内的模型未完成任务'},
  EVAL_PACKAGE_DEPENDENCIES_UNAVAILABLE:{code:'RUNTIME_DEPENDENCIES_UNAVAILABLE',message:'Runtime 缺少执行依赖'},
  EVAL_PACKAGE_EXECUTION_TIMEOUT:{code:'RUNTIME_TIME_LIMIT',message:'Runtime 执行达到时间上限'},
  EVAL_PACKAGE_ITERATION_LIMIT:{code:'RUNTIME_ITERATION_LIMIT',message:'Runtime 达到 Agent 迭代上限'},
  EVAL_PACKAGE_PROGRAM_MISSING:{code:'RUNTIME_PROGRAM_MISSING',message:'Runtime 无法找到启动程序'},
  EVAL_PACKAGE_MCP_TOOL_MISSING:{code:'RUNTIME_TOOL_MISSING',message:'Runtime 未发现所需 MCP 工具'},
};
/** Uses the existing suite, execution and Judge pipeline; owns only frozen reuse acceptance lifecycle. */
export class MigrationReuseAcceptanceService{
  private active=new Map<string,{controller:AbortController;done:Promise<void>}>();
  constructor(private d:{projects:MigrationProjectStore;configs:MigrationRuntimeConfigurationRepository;environments?:MigrationEnvironmentRepository;
    suites:MigrationSuiteService;execution:MigrationOpenJiuwenService;jobs:MigrationEvaluationJobReader;runs:MigrationEvaluationRunner;
    model:MigrationReuseAcceptanceModel;skills?:MigrationSkillRepository}){}

  private async artifactEvidence(assetId:string){
    if(!this.d.skills)return {};
    // readFiles is a documentation projection: it intentionally omits py/js and
    // does not verify the archive digest. Acceptance needs the same immutable
    // full archive used by candidate inspection and actual execution.
    const archive=await this.d.skills.readArchive(assetId),candidateFiles:Record<string,string>={};
    const candidateBinaryPaths:string[]=[];
    for(const [name,bytes] of Object.entries(archive)){
      try{candidateFiles[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
      catch{candidateBinaryPaths.push(name);}
    }
    return {candidateFiles,candidateFilePaths:Object.keys(archive).sort(),candidateBinaryPaths};
  }

  private async binding(id:string,choice:{environmentId:string;modelId:string}):Promise<ReuseAcceptanceBinding>{
    const project=await this.d.projects.get(id),proposal=currentReuseProposal(project);
    if(!proposal?.approvedAt||!project.candidate||project.candidateReuseProposalId!==proposal.proposalId
      ||project.inspection?.reuseConformance?.candidateDigest!==project.candidate.artifactSha256
      ||project.inspection.reuseConformance.proposalId!==proposal.proposalId)return conflict('请先生成并审查符合当前迁移方案的候选');
    const live=await migrationRuntimeCapabilities(this.d.environments,choice.environmentId);
    await verifyRuntimeReuse(project,this.d.environments,choice.environmentId);
    if(!live.capabilities.models.some(model=>model.modelId===choice.modelId))return conflict('执行模型不属于所选 Runtime');
    return {proposalId:proposal.proposalId,proposalDigest:digest({inputDigest:proposal.inputDigest,design:proposal.design}),candidateDigest:project.candidate.artifactSha256,
      inspectionDigest:digest({tools:project.inspection.tools,skill:project.inspection.skill,dependencies:project.inspection.dependencyAnalysis,capabilities:project.inspection.runtimeCapabilities,review:project.inspection.reuseConformance.review}),
      configurationDigest:executionConfigurationDigest(await this.d.configs.get(id),project.sourceInspection?.dependencyAnalysis?.dependencies),
      environmentId:choice.environmentId,launcherId:live.launcher.environmentId,environmentDigest:digest({selected:live.selected,launcher:live.launcher}),
      capabilitiesDigest:digest(live.capabilities),modelId:choice.modelId};
  }
  async propose(id:string,input:unknown,signal?:AbortSignal){
    signal?.throwIfAborted();
    const parsed=selection.extend({plan:z.unknown().optional()}).parse(input),binding=await this.binding(id,parsed);
    const project=await this.d.projects.get(id),proposal=currentReuseProposal(project)!;
    if(project.improvementTasks?.some(task=>activeStatuses.includes(task.status))||project.reuseAcceptanceResults?.some(task=>task.status==='RUNNING'))return conflict('请先完成或停止当前任务');
    const capabilities=(await migrationRuntimeCapabilities(this.d.environments,parsed.environmentId)).capabilities;
    const artifactEvidence=await this.artifactEvidence(project.candidate!.assetId);
    const context={executionContract:reuseExecutionContract,design:proposal.design,...artifactEvidence,candidateReview:project.inspection!.reuseConformance,tools:project.inspection!.tools.map(tool=>({name:tool.name,inputSchema:tool.inputSchema,outputSchema:tool.outputSchema,samples:tool.samples})),
      runtimeCapabilities:capabilities,executionSemantics:'group=new Runtime instances (not Launcher deployment); case=fresh native session/workspace/MCP scope; turns=preserved native session/workspace/MCP scope',
      evaluatorEvidence:{caseJudge:{available:['当前案例的实际查询、分轮输出及工具调用','成功读取与已挂载文件的摘要匹配','已声明 Script 实参与案例 JSON 字段值的摘要匹配'],unavailable:['原生实例/会话/工作区身份标识','其他案例或运行组的事实']},checkJudge:{available:['关联案例的输出、评测、调用和输入匹配','跨案例的实例/会话/工作区身份比较'],rule:'跨案例/组事实只能放 checks.criteria，不能放 case.criteria；不能因此删掉原要求'}},
      evidenceSemantics:'Per-case Judge receives actual turn queries, per-turn native output/tool-name receipts, overall tool calls, and authorized redacted business result projections. Original tool arguments are not exposed; hashes do not let Judge reconstruct them. Eval can exactly match read_file argument/result hashes to mounted case files, and Script input hashes to a JSON object projection using its declared inputSchema; these optional workspaceInputMatches prove value equality, not causal program data flow. Missing matches cannot be assumed. Instance/session/workspace identity comparisons belong to check-level verification across cases, not one-case criteria. Do not introduce unobservable criteria absent from original requirements; requirements genuinely depending on unavailable evidence remain uncovered.'};
    const output=parsed.plan??await this.d.model({mode:'PLAN',context,signal}),checkedPlan=reuseAcceptancePlanSchema.safeParse(output);
    if(!checkedPlan.success)throw new ReuseAcceptanceError({phase:'PLAN',code:parsed.plan===undefined?'MODEL_OUTPUT_INVALID':'PLAN_INPUT_INVALID',message:'验收计划字段不符合要求，请检查标出的字段',fields:checkedPlan.error.issues.slice(0,16).map(issue=>`${issue.path.join('.').slice(0,150)||'root'} (${issue.code})`)});
    const plan=checkedPlan.data;
    const issues=reuseAcceptancePlanIssues(project,plan);
    if(plan.groups.some(group=>group.cases.some(c=>c.turns&&c.turns.length>1))&&capabilities.features.multiTurn!==true)issues.push('所选 Runtime 不支持真实多轮续接');
    const coverage=issues.length?{status:'INCOMPLETE' as const,reasons:issues}:coverageSchema.parse(await this.d.model({mode:'COVERAGE',context:{...context,plan},signal}));
    return this.d.projects.runExclusive(id,async()=>{
      signal?.throwIfAborted();
      if(digest(await this.binding(id,parsed))!==digest(binding))return conflict('候选、方案或运行条件已变化，请重新生成验收计划');
      const current=await this.d.projects.get(id);
      if(current.reuseAcceptanceResults?.some(task=>task.status==='RUNNING')||current.improvementTasks?.some(task=>activeStatuses.includes(task.status)))return conflict('已有任务正在执行');
      const record={planId:`reuse-plan-${randomUUID()}`,createdAt:new Date().toISOString(),binding,plan,coverage,inputDigest:digest({binding,plan,coverage})};
      current.reuseAcceptancePlan=record;await this.d.projects.save(current);return record;
    });
  }
  async approve(id:string,input:unknown){
    const parsed=z.strictObject({planId:z.string(),inputDigest:z.string()}).parse(input);
    return this.d.projects.runExclusive(id,async()=>{
      const current=await this.d.projects.get(id),plan=current.reuseAcceptancePlan;
      if(!plan||!planIntact(plan)||plan.planId!==parsed.planId||plan.inputDigest!==parsed.inputDigest||plan.coverage.status!=='COVERED'
        ||reuseAcceptancePlanIssues(current,plan.plan).length)return conflict('验收计划尚未完整覆盖复用要求');
      if(digest(await this.binding(id,plan.binding))!==digest(plan.binding))return conflict('验收计划已失效');
      plan.approvedAt=new Date().toISOString();await this.d.projects.save(current);return plan;
    });
  }
  async start(id:string,input:unknown){
    const parsed=z.strictObject({planId:z.string(),inputDigest:z.string(),maximumDurationMs:z.number().int().min(60_000).max(7_200_000).default(1_800_000)}).parse(input);
    const task=await this.d.projects.runExclusive(id,async()=>{
      const project=await this.d.projects.get(id),plan=project.reuseAcceptancePlan;
      if(!plan?.approvedAt||!planIntact(plan)||plan.planId!==parsed.planId||plan.inputDigest!==parsed.inputDigest||plan.coverage.status!=='COVERED')return conflict('请先确认完整验收计划');
      if(project.reuseAcceptanceResults?.some(task=>task.status==='RUNNING')||project.improvementTasks?.some(task=>activeStatuses.includes(task.status)))return conflict('已有任务正在执行');
      if(digest(await this.binding(id,plan.binding))!==digest(plan.binding))return conflict('验收计划已失效');
      const task:ReuseAcceptanceResult={taskId:`reuse-test-${randomUUID()}`,planId:plan.planId,planDigest:plan.inputDigest,binding:plan.binding,startedAt:new Date().toISOString(),status:'RUNNING',jobs:[],
        checks:plan.plan.checks.map(check=>({checkId:check.checkId,status:'NOT_RUN',reason:'尚未执行',caseIds:check.caseIds}))};
      (project.reuseAcceptanceResults??=[]).push(task);await this.d.projects.save(project);return task;
    });
    const controller=new AbortController(),deadline=setTimeout(()=>controller.abort('TIME_LIMIT'),parsed.maximumDurationMs);
    const done=this.execute(id,task,controller.signal).catch(async(error:unknown)=>{
      task.status=controller.signal.reason==='SERVICE_SHUTDOWN'?'INTERRUPTED':controller.signal.aborted&&controller.signal.reason!=='TIME_LIMIT'?'CANCELLED':'INDETERMINATE';
      task.reason=controller.signal.reason==='TIME_LIMIT'?'验收达到时间上限，未形成通过结论':'验收未完成或条件已变化，请查看执行记录';
      if(!controller.signal.aborted&&error instanceof Error&&(error as Error&{statusCode?:number}).statusCode===409)task.reason=error.message.slice(0,500);
      task.failure=error instanceof ReuseAcceptanceError&&!controller.signal.aborted?error.failure:{phase:task.phase??'PREPARATION',
        code:controller.signal.reason==='TIME_LIMIT'?'TIME_LIMIT':controller.signal.aborted?'EXECUTION_INTERRUPTED':error instanceof Error&&(error as Error&{statusCode?:number}).statusCode===409?'ACCEPTANCE_CONDITION_CHANGED':'ACCEPTANCE_STAGE_FAILED',message:task.reason};
      for(const check of task.checks)if(check.status==='NOT_RUN'){check.status='INDETERMINATE';check.reason=task.reason;}
      await this.save(id,task);
    }).finally(async()=>{clearTimeout(deadline);for(const job of task.jobs)await this.d.runs.cancel?.(job.jobId).catch(()=>undefined);this.active.delete(task.taskId);});
    this.active.set(task.taskId,{controller,done});return task;
  }
  async cancel(id:string,taskId:string){
    const project=await this.d.projects.get(id),task=project.reuseAcceptanceResults?.find(t=>t.taskId===taskId);
    if(!task||task.status!=='RUNNING')return conflict('没有正在执行的复用验收');
    this.active.get(taskId)?.controller.abort('USER_CANCELLED');
    task.status='CANCELLED';task.reason='已停止，不形成复用通过结论';await this.save(id,task);return task;
  }
  async summary(id:string):Promise<ReuseAcceptanceSummary>{
    let project=await this.d.projects.get(id);
    for(const task of project.reuseAcceptanceResults??[])if(task.status==='RUNNING'&&!this.active.has(task.taskId)){
      task.status='INTERRUPTED';task.reason='服务已重启，未自动重放验收';await this.save(id,task);
    }
    project=await this.d.projects.get(id);const plan=project.reuseAcceptancePlan,latest=project.reuseAcceptanceResults?.at(-1);
    let current=false;
    if(plan)try{current=planIntact(plan)&&digest(await this.binding(id,plan.binding))===digest(plan.binding);}catch{}
    const resultCurrent=current&&latest?.planId===plan?.planId&&latest?.planDigest===plan?.inputDigest;
    return {plan:plan??null,current,status:resultCurrent?latest!.status:latest?'STALE':'NOT_RUN',result:latest??null};
  }
  async shutdown(){for(const active of this.active.values())active.controller.abort('SERVICE_SHUTDOWN');await Promise.all([...this.active.values()].map(value=>value.done));}
  private async save(id:string,task:ReuseAcceptanceResult,observed?:Array<Record<string,unknown>>){
    return this.d.projects.runExclusive(id,async()=>{const project=await this.d.projects.get(id),index=project.reuseAcceptanceResults?.findIndex(t=>t.taskId===task.taskId)??-1;
      if(index<0)return conflict('验收任务不存在');
      if(project.reuseAcceptanceResults![index]!.status==='CANCELLED'){task.status='CANCELLED';return;}
      if(task.status==='PASSED'&&digest(await this.binding(id,task.binding))!==digest(task.binding))return conflict('验收条件已变化，不能保存通过结论');
      if(task.status!=='RUNNING')task.finishedAt=new Date().toISOString();
      if(task.status==='PASSED'&&observed){
        for(const tool of project.inspection?.tools??[]){
          const calls=observed.filter(c=>(c.toolCalls as Array<{name:string;status:string}>).some(t=>t.name===tool.name&&t.status==='completed'));
          if(!calls.length)continue;
          (project.technicalValidations??=[]).push({validationId:`reuse-tool-${randomUUID()}`,toolId:tool.toolId,assetId:project.candidate!.assetId,assetDigest:task.binding.candidateDigest,
            implementationDigest:task.binding.candidateDigest,casesDigest:task.planDigest,runtimeConfigurationDigest:task.binding.configurationDigest,mode:'RUNTIME_INTEGRATED',status:'PASSED',
            startedAt:task.startedAt,finishedAt:task.finishedAt!,stages:[{name:'RUNTIME_INTEGRATED',passed:true,message:'已在确认的复用验收中完成真实工具调用'}],error:null,
            reuseAcceptanceTaskId:task.taskId,jobIds:[...new Set(calls.map(c=>c.jobId as string))]});
        }
      }
      project.reuseAcceptanceResults![index]=structuredClone(task);await this.d.projects.save(project);});
  }
  private async guard(id:string,task:ReuseAcceptanceResult,signal:AbortSignal){
    signal.throwIfAborted();const project=await this.d.projects.get(id);
    if(project.reuseAcceptanceResults?.find(t=>t.taskId===task.taskId)?.status!=='RUNNING'||!project.reuseAcceptancePlan||!planIntact(project.reuseAcceptancePlan)||project.reuseAcceptancePlan.inputDigest!==task.planDigest
      ||digest(await this.binding(id,task.binding))!==digest(task.binding))return conflict('验收绑定已变化，旧结论不能继续使用');
  }
  private async execute(id:string,task:ReuseAcceptanceResult,signal:AbortSignal){
    const project=await this.d.projects.get(id),plan=project.reuseAcceptancePlan!.plan,candidate=project.candidate!,observed:Array<Record<string,unknown>>=[];
    for(const group of plan.groups){
      task.phase='PREPARATION';await this.save(id,task);
      await this.guard(id,task,signal);
      const suite=await this.d.suites.importSimple(id,{name:`复用验收：${plan.name} · ${group.id}`,cases:group.cases});
      const variant={mode:'skill_version' as const,skillId:candidate.skillId,version:candidate.version,artifactSha256:candidate.artifactSha256};
      const side={environmentId:task.binding.environmentId,skillAssetId:candidate.assetId};
      const configuration=runConfigurationSchema.parse({preparationId:suite.preparationId,runtime:{type:'runtime_launcher',environmentId:task.binding.environmentId},
        runtimeBindings:{left:side,right:side},leftVariant:variant,rightVariant:variant,executionModel:{providerId:`runtime-launcher:${task.binding.environmentId}`,modelId:task.binding.modelId,parameters:{}},judgeMode:'model',evaluationMode:'candidate_assessment'});
      const started=await this.d.execution.validateReuseAcceptance(id,{pair:'BC',configuration,dataSnapshot:task.planDigest,permissionBasis:'用户确认的复用验收计划',sourceProjectRef:task.binding.proposalId,dependencyLockRef:task.binding.configurationDigest},task.taskId,task.planDigest);
      await this.d.projects.runExclusive(id,async()=>{const current=await this.d.projects.get(id),run=current.runs.find(r=>r.jobId===started.job.jobId);if(run){run.reuseAcceptanceTaskId=task.taskId;await this.d.projects.save(current);}});
      task.jobs.push({groupId:group.id,jobId:started.job.jobId});task.phase='EXECUTION';await this.save(id,task);
      const fail=(code:string,message:string,caseId?:string,fields?:string[])=>{throw new ReuseAcceptanceError({phase:'EXECUTION',code,message,groupId:group.id,jobId:started.job.jobId,...(caseId?{caseId}:{}),...(fields?{fields}:{})});};
      let job=this.d.jobs.get(started.job.jobId);
      while(job&&['queued','preparing','running','judging'].includes(job.status)){
        await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(signal.reason)};
          const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve()},1000);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
        await this.guard(id,task,signal);job=this.d.jobs.get(started.job.jobId);
      }
      if(job?.status!=='completed'||!job.report)return fail('RUN_NOT_COMPLETED',`运行组 ${group.id} 未完成，请查看关联运行记录`);
      const results=job.report.cases;
      if(results.length!==group.cases.length||new Set(results.map(c=>c.caseId)).size!==group.cases.length
        ||group.cases.some(c=>!results.some(r=>r.caseId===c.id)))return fail('CASE_COVERAGE_MISMATCH','运行结果未完整覆盖确认的案例');
      for(const result of results){
        const evidence=result.right,definition=group.cases.find(c=>c.id===result.caseId)!;
        if(evidence.status!=='completed'){
          const failure=typeof evidence.error==='string'?runtimeFailures[evidence.error]:undefined;
          return fail(failure?.code??'CASE_EXECUTION_FAILED',`案例 ${result.caseId}：${failure?.message??'未成功执行'}，不能判定复用通过`,result.caseId);
        }
        if(result.judgeError)return fail('CASE_JUDGE_FAILED',`案例 ${result.caseId} 的业务评测调用失败`,result.caseId);
        const missing=[!evidence.runtimeIdentityVerified?'runtimeIdentityVerified':null,!evidence.streamCompleted?'streamCompleted':null,
          evidence.metadata.skillArtifactSha256!==candidate.artifactSha256?'skillArtifactSha256':null,
          typeof evidence.metadata.instanceId!=='string'||!evidence.metadata.instanceId?'instanceId':null,
          typeof evidence.metadata.caseScopeId!=='string'||!evidence.metadata.caseScopeId?'caseScopeId':null].filter((field):field is string=>!!field);
        if(missing.length)return fail('RUNTIME_EVIDENCE_MISSING',`案例 ${result.caseId} 缺少有效执行证据：${missing.join('、')}`,result.caseId,missing);
        if(definition.turns&&definition.turns.length>1&&!evidence.metadata.conversation)return fail('CONVERSATION_EVIDENCE_MISSING',`案例 ${result.caseId} 缺少真实会话续接证据`,result.caseId,['conversation']);
        observed.push({caseId:result.caseId,groupId:group.id,jobId:job.jobId,output:evidence.output,
          instanceId:evidence.metadata.instanceId,caseScopeId:evidence.metadata.caseScopeId,conversation:evidence.metadata.conversation,
          toolCalls:evidence.toolCalls,toolEvidence:evidence.metadata.toolEvidence,
          workspaceInputMatches:judgeRuntimeEvidence(evidence,{workspaceFiles:definition.workspaceFiles,tools:project.inspection?.tools}).workspaceInputMatches,
          assessment:result.judge?.goalAssessment});
      }
    }
    await this.guard(id,task,signal);
    task.phase='VERIFICATION';await this.save(id,task);
    // Independent cases cannot masquerade as isolated when their scopes repeat.
    if(new Set(observed.map(c=>c.caseScopeId)).size!==observed.length)return conflict('独立案例复用了执行上下文');
    const conversations=observed.flatMap(c=>c.conversation?[c.conversation as {sessionId:string;workspaceId:string}]:[]);
    if(new Set(conversations.map(c=>c.sessionId)).size!==conversations.length||new Set(conversations.map(c=>c.workspaceId)).size!==conversations.length)return conflict('独立案例复用了会话或工作区');
    const groupInstances=plan.groups.map(group=>[...new Set(observed.filter(c=>c.groupId===group.id).map(c=>c.instanceId))]);
    if(groupInstances.some(ids=>ids.length!==1)||new Set(groupInstances.flat()).size!==plan.groups.length)return conflict('新运行组没有使用独立 Runtime 实例');
    const design=currentReuseProposal(await this.d.projects.get(id))!.design;
    // Static document/code checks and dynamic behavior checks have different
    // evidence. Re-read this bound artifact, not an uploaded workspace copy or a
    // model's statement that it inspected the delivered files.
    const current=await this.d.projects.get(id);
    const artifactEvidence=await this.artifactEvidence(candidate.assetId);
    await this.guard(id,task,signal);
    const verdicts=reuseAcceptanceVerdictsSchema.parse(await this.d.model({mode:'VERIFY',context:{scope:design.scope,conditions:design.conditions,requirements:design.acceptanceChecks,plan,observed,
      ...artifactEvidence,candidateReview:current.inspection?.reuseConformance,artifactDigest:task.binding.candidateDigest},signal}));
    if(verdicts.checks.length!==plan.checks.length||new Set(verdicts.checks.map(c=>c.checkId)).size!==plan.checks.length)return conflict('复用验收判定未完整覆盖要求');
    for(const result of verdicts.checks){const expected=plan.checks.find(c=>c.checkId===result.checkId);
      if(!expected||new Set(result.caseIds).size!==result.caseIds.length||result.caseIds.some(c=>!expected.caseIds.includes(c))
        ||expected.caseIds.some(c=>!result.caseIds.includes(c)))return conflict('复用验收结论引用不完整或不存在的执行证据');
      const unresolved=observed.filter(c=>result.caseIds.includes(c.caseId as string)&&(c.assessment as {verdict?:string})?.verdict!=='PASS');
      if(result.status==='PASSED'&&unresolved.length){
        result.status=unresolved.some(c=>(c.assessment as {verdict?:string})?.verdict==='FAIL')?'FAILED':'INDETERMINATE';
        result.reason='案例未全部通过：'+unresolved.map(c=>`${c.caseId}：${(c.assessment as {reason?:string})?.reason?.slice(0,500)??'缺少业务评测结论'}`).join('；');
      }
    }
    await this.guard(id,task,signal);task.checks=verdicts.checks;
    task.status=task.checks.some(c=>c.status==='FAILED')?'FAILED':task.checks.some(c=>c.status!=='PASSED')?'INDETERMINATE':'PASSED';
    if(task.status!=='PASSED'){
      const check=task.checks.find(c=>c.status===task.status)!,failedCase=observed.find(c=>check.caseIds.includes(c.caseId as string)&&(c.assessment as {verdict?:string})?.verdict!=='PASS');
      task.reason=check.reason.slice(0,1500);task.failure={phase:'VERIFICATION',code:task.status==='FAILED'?'REUSE_CHECK_FAILED':'REUSE_CHECK_INDETERMINATE',message:task.reason,
        ...(failedCase?{caseId:failedCase.caseId as string,jobId:failedCase.jobId as string,groupId:failedCase.groupId as string}:{})};
    }
    await this.save(id,task,observed);
  }
}
