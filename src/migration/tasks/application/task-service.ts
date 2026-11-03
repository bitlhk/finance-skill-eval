import type { MigrationActivityPort } from '../../application/migration-activity-port.js';
import { exportMigrationTask } from './task-export.js';
import { acceptMigrationTask } from './task-acceptance.js';
import {rescoreRequestSchema,rescoreTask} from './task-rescoring.js';
import {analyzeSavedRun} from './task-run-analysis.js';
import {optimizeMigrationTask} from './task-optimization.js';
import {activateOptimizationRun,prepareOptimizationResume,waitingOptimization} from './task-optimization-state.js';
import {assertMigrationExportSafe} from '../../domain/migration-export-safety.js';
import {optimizationGoalSchema} from '../../../improvement/domain/optimization-loop.js';
import type {ImprovementAgents} from '../../../improvement/application/improvement-agents.js';
import { randomUUID } from 'node:crypto';
import { operationalError } from '../../../shared/operational-error.js';
import { canonicalSha256 } from '../../../shared/json-canonicalization.js';
import { simpleMigrationCases } from '../../domain/simple-migration-suite.js';
import type { BundleAgent, BundleRuntimeFactory, BundleJudge, MigrationTaskRepository, MigrationSourceAssets, MigrationLogger, TaskBuilderPort } from './task-ports.js';
import { TaskBuilderService } from './task-builder.js';
import { z } from 'zod';
import { projectPreparationSchema, projectExecutionReceiptSchema } from '../domain/project-preparation.js';
import { projectSnapshot, currentBaselineRun, baselineRunForPreparation } from '../domain/task-model.js';
import { evidenceIssues } from '../../domain/migration-reuse-design.js';
import {sourceEvidencePath} from '../../domain/migration-source-evidence.js';
import { reviewPlanEnvironment } from '../domain/task-runtime-review.js';
import {standardizationIssues,standardDeliveryIssues,conformancePassed} from '../domain/task-standardization.js';
import {runtimeInputIssues} from '../domain/task-runtime-inputs.js';
import {
  analysisSchema,
  deliverySchema,
  bundleError,
  createBundleSchema,
  defaultTaskDescription,
  operationSchema,
  configurationSchema,
  bundleSuiteSchema,
  snapshot,
  bundleZip,
  decodeBundleZip,
  bundleDiff,
  currentCandidate,completedRepetitions,
  hasCandidateFailures,
  approvedTaskPlan, candidateUsesCurrentPlan,
  readText,
  taskBuilderStatus, requireTaskBuilderBinding, requireBuilderEnvironment, verifiedRun,
  type BundleTask,
  type BundleAttempt,
  type BundleFiles,
  type BundleConfiguration,
} from '../domain/task-model.js';

/** One task owns one full workspace. Persisted candidates and run inputs are immutable. */
export class MigrationTaskService {
  private operations = new Set<{ taskId: string; controller: AbortController; done: Promise<void>; rescoring?:boolean }>();
  private closing = false;
  private static executing = 0;
  constructor(
    private repository: MigrationTaskRepository,
    private skills: MigrationSourceAssets,
    private agent: BundleAgent,
    private runtime: BundleRuntimeFactory,
    private judge: BundleJudge,
    private logger?: MigrationLogger,
    builder?: TaskBuilderPort,
    readonly activity?: MigrationActivityPort,
    private improvementAgents?:()=>ImprovementAgents,
  ) { this.builder = builder ? new TaskBuilderService(repository, builder, logger) : undefined; }
  readonly builder?: TaskBuilderService;
  async initialize() {
    for (const task of await this.repository.list()) {
      let changed = false;
      if (task.startupCheck?.status === 'RUNNING') {
        task.startupCheck.status = 'INTERRUPTED';
        task.startupCheck.message = '服务重启，启动检查中断，请重新检查';
        changed = true;
      }
      for (const attempt of task.attempts)
        if (attempt.status === 'RUNNING') {
          if(attempt.optimization?.status==='WAITING'){
            attempt.status='WAITING';attempt.message=attempt.optimization.reason??'等待外部调整';changed=true;continue;
          }
          attempt.status = 'INTERRUPTED';
          if(attempt.optimization?.status==='RUNNING'){attempt.optimization.status='INTERRUPTED';attempt.optimization.reason='服务重启，优化中断，实验候选未自动采纳';}
          attempt.message = '服务已重启，本次操作中断；可重新发起';
          attempt.finishedAt = new Date().toISOString();
          changed = true;
        }
      for (const run of task.runs)
        if (run.status === 'RUNNING') {
          run.status = 'INCOMPLETE';
          run.finishedAt = new Date().toISOString();
          changed = true;
        }
      if (changed) {
        await this.repository.save(task);
        this.logger?.warn({ event: 'bundle_recovered_after_restart', taskId: task.id });
      }
    }
  }
  private view(task: BundleTask): BundleTask {
    const current = { ...task, currentJudgeDigest: this.judge.identity?.(), builderStatus: taskBuilderStatus(task) };
    const check = task.startupCheck;
    const startupCheckCurrent = Boolean(candidateUsesCurrentPlan(task) && check && task.configuration && check.candidateId === task.currentCandidateId
      && check.configurationDigest === canonicalSha256(task.configuration)
      && check.runtimeSelectionRevision === task.runtimeSelectionRevision
      && check.builderBindingId === (task.selectedRuntimeBuildRequestId ? task.runtimeDelivery?.id : undefined)
      && !['PENDING', 'STALE'].includes(current.builderStatus));
    const currentPlanDigest = task.analysis ? canonicalSha256(task.analysis) : undefined;
    const runtimeReviewCurrent = Boolean(task.runtimeReview && task.configuration && candidateUsesCurrentPlan(task)
      && task.runtimeReview.candidateId === task.currentCandidateId && task.runtimeReview.configurationDigest === canonicalSha256(task.configuration)
      && task.runtimeReview.planDigest === currentPlanDigest && task.runtimeReview.runtimeSelectionRevision === task.runtimeSelectionRevision);
    return { ...current, currentPlanDigest, planApproved: approvedTaskPlan(task), candidatePlanCurrent: candidateUsesCurrentPlan(task),
      runtimeReviewCurrent, startupCheckCurrent, verifiedRunId: verifiedRun(current)?.id,
      ...(task.preparations ? {preparations:task.preparations.map(preparation=>({...preparation,
        baselineStatus:baselineRunForPreparation(task,preparation,this.judge.identity?.())?.status ?? 'NOT_EVALUATED' as const}))} : {}),
      currentBaselineRunId: currentBaselineRun(task, this.judge.identity?.())?.id };
  }
  async list() { return (await this.repository.list()).map(task => this.view(task)); }
  async get(id: string) { return this.view(await this.repository.get(id)); }
  readSnapshot(id: string, candidateId: string | null) { return this.repository.readSnapshot(id, candidateId); }
  private async update(id: string, change: (task: BundleTask) => void | Promise<void>) { return this.view(await this.repository.update(id, change)); }
  private idle(task: BundleTask,allowRescore=false) {
    if(!allowRescore&&[...this.operations].some(operation=>operation.taskId===task.id&&operation.rescoring))bundleError('正在评判或分析已保存证据，请等待或取消');
    if (task.attempts.some((a) => a.status === 'RUNNING')) bundleError('任务正在执行，请等待或取消当前操作');
  }
  create(input: unknown, requestId?: string) { return this.createFromAssets(input, requestId); }
  private async createFromAssets(input: unknown, requestId?: string) {
    const parsed = createBundleSchema.parse(input);
    if (new Set(parsed.sourceAssetIds).size !== parsed.sourceAssetIds.length)
      bundleError('不能重复选择同一资产', 400);
    const files: BundleFiles = {};
    for (const [index, id] of parsed.sourceAssetIds.entries()) {
      const asset = await this.skills.get(id);
      if (!asset) bundleError('源 Skill 不存在', 404);
      const archive = await this.skills.readArchive(id);
      for (const [name, bytes] of Object.entries(archive))
        files['members/member-' + (index + 1) + '/' + name] = Buffer.from(bytes).toString('base64');
    }
    for (const [name, content] of Object.entries(parsed.assets ?? {})) {
      if (name in files || name.split('/').at(-1)?.toLowerCase() === 'skill.md') bundleError('依赖文件不能覆盖 Skill 或添加未选择的 Skill',400);
      if (Buffer.from(content,'base64').toString('base64') !== content) bundleError('依赖文件编码无效',400);
      files[name] = content;
    }
    return this.createFiles(parsed, files, requestId);
  }
  async upload(input: unknown, zip: Buffer, requestId?: string) {
    if (input && typeof input === 'object' && 'configuration' in input && typeof input.configuration === 'string') {
      try { input = { ...input, configuration: JSON.parse(input.configuration) }; }
      catch { bundleError('运行配置格式无效', 400); }
    }
    const parsed = createBundleSchema.omit({ sourceAssetIds: true }).parse(input);
    return this.createFiles(parsed, decodeBundleZip(zip), requestId);
  }
  private async createFiles(input: { name: string; goal: string; target: string; inputKind?: 'skill_package'|'agent_project'; projectNotes?: string; configuration?: BundleConfiguration }, files: BundleFiles, requestId?: string) {
    const id = 'bundle-' + randomUUID(),
      source = input.inputKind === 'agent_project' ? projectSnapshot(files) : snapshot(files, 'source');
    const { files: _, ...sourceInfo } = source;
    const defaults = defaultTaskDescription(source);
    const task: BundleTask = {
      schemaVersion: 'finance.skill-migration.task.v1',
      id,
      name: input.name || defaults.name, goal: input.goal || defaults.goal, target: input.target || defaults.target,
      ...(input.configuration ? { configuration: input.configuration } : {}),
      requestId,
      createdAt: new Date().toISOString(),
      source: sourceInfo,
      inputKind: input.inputKind ?? 'skill_package', projectNotes: input.projectNotes ?? '',
      currentCandidateId: null,
      candidates: [],
      attempts: [],
      runs: [],
    };
    await this.repository.saveSnapshot(id, 'source', source);
    await this.repository.save(task);
    this.logger?.info({ event: 'migration_task_created', taskId: task.id, requestId, memberCount: source.members.length });
    return task;
  }
  async configure(id: string, input: unknown, purpose: 'baseline'|'candidate' = 'candidate') {
    const configuration = configurationSchema.parse(input);
    return this.update(id, (task) => {
      this.idle(task);
      if (purpose === 'baseline') {
        if (task.inputKind !== 'agent_project') bundleError('仅完整工程可配置原工程基线');
        if (configuration.entryInstructionsFile || configuration.harnessTools.length) bundleError('原工程基线不注入 Skill 入口或 Harness 工具');
        task.baselineConfiguration = configuration;
        return;
      }
      const issues=runtimeInputIssues(task,configuration);if(issues.length)bundleError(issues.join('；'));
      task.configuration = configuration;
      task.configurationConfirmed = true;
    });
  }
  async approvePlan(id: string, input: unknown) {
    const { analysisDigest } = z.strictObject({analysisDigest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(input);
    return this.update(id, task => {
      this.idle(task);
      if(waitingOptimization(task))bundleError('优化正在等待外部调整；修改方案前请先停止优化');
      if (!task.analysis || canonicalSha256(task.analysis) !== analysisDigest) bundleError('方案已变化，请刷新后重新确认');
      if (task.analysis.missing.length || task.analysis.plan?.unresolvedQuestions.length) bundleError('请先补充方案中的待确认事项');
      let revision = task.planRevisions?.find(item => item.id === task.planRevisionId);
      if (!revision) {
        revision = {id:'plan-'+randomUUID(),digest:analysisDigest,analysis:structuredClone(task.analysis),baseCandidateId:task.currentCandidateId,createdAt:new Date().toISOString()};
        (task.planRevisions ??= []).push(revision); task.planRevisionId=revision.id;
        // Adopt the unchanged existing plan without rewriting its candidate files or evidence.
        const candidate=currentCandidate(task); if(candidate && !candidate.planRevisionId) candidate.planRevisionId=revision.id;
      }
      if (revision.digest !== analysisDigest) bundleError('方案版本不一致，请重新分析后确认');
      revision.approvedAt = new Date().toISOString();
    });
  }
  async reviewRuntime(id: string) {
    const task=await this.get(id), candidate=currentCandidate(task);
    if (!candidate || !task.configuration || !candidateUsesCurrentPlan(task)) bundleError('请先确认方案、生成当前结果并选择运行环境');
    const execution=await this.runtime({snapshot:await this.readSnapshot(id,candidate.id),services:candidate.services,configuration:task.configuration,signal:AbortSignal.timeout(60000)});
    requireBuilderEnvironment(task,execution.environmentSnapshot);
    const review=reviewPlanEnvironment(task,execution.environmentSnapshot);
    return this.update(id,current=>{
      this.idle(current);
      if(current.currentCandidateId!==candidate.id || canonicalSha256(current.configuration)!==canonicalSha256(task.configuration)
        || (current.analysis?canonicalSha256(current.analysis):undefined)!==task.currentPlanDigest || current.runtimeSelectionRevision!==task.runtimeSelectionRevision)
        bundleError('方案、结果或环境配置已变化，请重新核对');
      current.runtimeReview=review;
    });
  }
  async saveSuite(id: string, input: unknown) {
    const suite = bundleSuiteSchema.parse(input);
    return this.update(id, (task) => {
      this.idle(task);
      if(waitingOptimization(task))bundleError('优化正在等待外部调整；测试集保持冻结，请先停止优化再修改');
      task.suite = suite;
    });
  }
  async rescore(id:string,input:unknown){
    const request=rescoreRequestSchema.parse(input);
    return this.withSavedEvidence(id,(task,signal)=>rescoreTask(task,request,this.judge,signal),
      (task,result)=>{(task.rescorings??=[]).push(result);});
  }
  async analyzeRun(id:string,input:unknown){
    const request=z.strictObject({runId:z.string().min(1)}).parse(input);
    return this.withSavedEvidence(id,async(task,signal)=>{
      if(!this.improvementAgents)bundleError('问题分析 Agent 尚未配置');
      const run=task.runs.find(item=>item.id===request.runId);
      if(!run)bundleError('运行记录不存在');
      return analyzeSavedRun(task,run,await this.readSnapshot(id,run.candidateId),this.improvementAgents().diagnose,signal);
    },(task,result)=>{(task.runAnalyses??=[]).push(result);});
  }
  private async withSavedEvidence<T extends {sourceRunId:string;sourceDigest:string}>(id:string,
    execute:(task:BundleTask,signal:AbortSignal)=>Promise<T>,save:(task:BundleTask,result:T)=>void){
    const task=await this.get(id);
    this.idle(task);
    if(this.closing||[...this.operations].some(operation=>operation.taskId===id))bundleError('任务正在执行');
    const controller=new AbortController();
    const operation={taskId:id,controller,done:Promise.resolve(),rescoring:true};
    this.operations.add(operation);
    const execution=Promise.resolve().then(async()=>{
      const result=await execute(task,controller.signal);
      return await this.update(id,current=>{this.idle(current,true);controller.signal.throwIfAborted();
        const source=current.runs.find(run=>run.id===result.sourceRunId);
        if(!source||canonicalSha256(source)!==result.sourceDigest)bundleError('原始运行记录已变化');
        save(current,result);
      });
    });
    operation.done=execution.then(()=>{},()=>{});
    try{return await execution;}finally{this.operations.delete(operation);}
  }
  async checkRuntime(id: string) {
    const task = await this.get(id),
      candidate = currentCandidate(task);
    if (!candidate || !task.configuration) bundleError('请先生成候选并配置运行环境');
    if (!candidateUsesCurrentPlan(task)) bundleError('当前结果对应旧方案，请确认并生成最新方案');
    const inputIssues=runtimeInputIssues(task,task.configuration,true);if(inputIssues.length)bundleError(inputIssues.join('；')+'。请在准备运行环境中补充，尚不能进行运行验证。');
    requireTaskBuilderBinding(task);
    const checkId = randomUUID();
    await this.update(id, current => {
      this.idle(current);
      if (current.currentCandidateId !== candidate.id || canonicalSha256(current.configuration) !== canonicalSha256(task.configuration))
        bundleError('候选或运行配置已变化，请刷新后重试');
      current.startupCheck = { id: checkId, candidateId: candidate.id, configurationDigest: canonicalSha256(task.configuration),
        runtimeSelectionRevision: task.runtimeSelectionRevision, builderBindingId: task.selectedRuntimeBuildRequestId ? task.runtimeDelivery?.id : undefined,
        status: 'RUNNING', startedAt: new Date().toISOString(), message: '正在启动并检查实例' };
    });
    try {
      const result = await this.runtime({
        snapshot: await this.readSnapshot(id, candidate.id),
        services: candidate.services,
        configuration: task.configuration,
        signal: AbortSignal.timeout(60000),
      });
      try {
        requireBuilderEnvironment(task, result.environmentSnapshot);
        const review=reviewPlanEnvironment(task,result.environmentSnapshot);
        await this.update(id,current=>{ if(current.startupCheck?.id===checkId) current.runtimeReview=review; });
        if(review.status==='FAILED') bundleError('运行环境不满足迁移方案要求，请查看环境核对结果');
        await result.runtime.prepare?.({runId:'startup-'+randomUUID(),signal:AbortSignal.timeout(task.configuration.timeoutMs)});
      }
      finally { await result.runtime.cleanup?.(); }
      await this.update(id, current => {
        if (current.startupCheck?.id === checkId) { current.startupCheck.status = 'PASSED'; current.startupCheck.message = '启动检查已通过，实例已释放'; }
      });
      return {
        status: 'READY',
        scope: 'INSTANCE_START_AND_RELEASE',
        message: '全部 Skill 已完成启动检查并释放实例；业务结果由联合验收核验',
        runtime: result.environmentSnapshot,
      };
    } catch (error) {
      await this.update(id, current => {
        if (current.startupCheck?.id === checkId) { current.startupCheck.status = 'FAILED'; current.startupCheck.message = '启动检查失败，请检查环境配置后重试'; }
      });
      throw error;
    }
  }
  async start(id: string, kind: BundleAttempt['kind'], input: unknown, requestId?: string) {
    if (this.closing) bundleError('服务正在关闭', 503);
    const operation = { taskId: id, controller: new AbortController(), done: Promise.resolve() };
    let execution = Promise.resolve();
    // Own registration before any repository await, including duplicate/failed
    // requests. Each request has its own lifetime so it cannot remove a sibling.
    this.operations.add(operation);
    const registration = Promise.resolve().then(() => this.registerAndStart(
      id, kind, input, operation.controller.signal, done => { execution = done; }, requestId,
    ));
    operation.done = registration.then(() => execution, () => {}).finally(() => this.operations.delete(operation));
    // Background execution can reject if terminal persistence fails. Keep the
    // original promise observable to lifecycle owners without an unhandled rejection.
    void operation.done.catch(() => {});
    return registration;
  }
  private async registerAndStart(
    id: string, kind: BundleAttempt['kind'], input: unknown, signal: AbortSignal,
    trackExecution: (done: Promise<void>) => void, requestId?: string,
  ) {
    const parsed = operationSchema.parse(input);
    const optimizationGoal=kind==='OPTIMIZE'?optimizationGoalSchema.parse(parsed.optimization??{}):undefined;
    const agents=kind==='OPTIMIZE'?this.improvementAgents?.():undefined;
    if(kind==='OPTIMIZE'&&!agents)bundleError('优化诊断与独立审查尚未配置');
    const requestDigest = canonicalSha256({ kind, input: parsed });
    let duplicate = false,
      reserved = false;
    const task = await this.update(id, (task) => {
      signal.throwIfAborted();
      const existing = task.attempts.find((a) => a.key === parsed.key||a.resumeRequests?.some(r=>r.key===parsed.key));
      if (existing) {
        if ((existing.resumeRequests?.find(r=>r.key===parsed.key)?.digest??existing.requestDigest) !== requestDigest) bundleError('请求标识已用于其他操作');
        duplicate = true;
        return;
      }
      if (this.closing) bundleError('服务正在关闭', 503);
      this.idle(task);
      if (MigrationTaskService.executing >= 2) bundleError('整组任务执行资源繁忙，请稍后重试', 429);
      if (parsed.baseCandidateId !== task.currentCandidateId) bundleError('候选已变化，请刷新后重试');
      if(parsed.resumeAttemptId){
        if(kind!=='OPTIMIZE'||parsed.optimization!==undefined)bundleError('恢复时不能更改优化目标或预算');
        const waiting=task.attempts.find(a=>a.id===parsed.resumeAttemptId);
        if(!waiting||waiting.kind!=='OPTIMIZE')bundleError('优化任务不存在');
        prepareOptimizationResume(task,waiting,this.judge.identity?.());
        (waiting.resumeRequests??=[]).push({key:parsed.key,digest:requestDigest});
        MigrationTaskService.executing++;reserved=true;return;
      }
      if(waitingOptimization(task))bundleError('优化正在等待外部调整，请继续或停止该优化任务');
      if (kind === 'BASELINE' && (task.inputKind !== 'agent_project' || !task.preparations?.length || !task.baselineConfiguration || !task.suite))
        bundleError('请先准备完整工程、保存基线运行环境与测试集');
      if (kind === 'BASELINE' && parsed.phase !== 'development') bundleError('基线使用开发测试集，独立留出集保留用于验收');
      if (kind === 'PREPARE' && (task.inputKind !== 'agent_project' || task.currentCandidateId))
        bundleError('工程运行准备仅用于尚未生成迁移候选的完整工程');
      if (kind === 'GENERATE' && (!task.analysis || task.analysis.missing.length))
        bundleError('请先完成整体分析并解决缺失信息');
      if (kind === 'GENERATE' && !approvedTaskPlan(task)) bundleError('请先确认当前迁移方案');
      if (['ACCEPT','REPAIR','OPTIMIZE'].includes(kind) && !candidateUsesCurrentPlan(task)) bundleError('方案已更新，请先确认并生成对应结果');
      if(kind==='OPTIMIZE'){
        const run=task.runs.find(r=>r.id===parsed.runId);
        if(!run||run.phase!=='development'||run.candidateId!==task.currentCandidateId||!['PASSED','FAILED'].includes(run.status)
          ||run.cases.some(c=>c.failureStage)||!run.cases.length||!completedRepetitions(task,run))bundleError('请先对当前候选完成完整的开发集评测');
        if(run.configurationDigest!==canonicalSha256(task.configuration)||run.suiteDigest!==canonicalSha256(task.suite)
          ||run.judgeDigest!==this.judge.identity?.()||run.runtimeSelectionRevision!==task.runtimeSelectionRevision)
          bundleError('环境、评测标准或运行条件已变化，请重新评测');
        if(task.runs.some(r=>r.phase==='holdout'&&r.suiteDigest===run.suiteDigest))bundleError('这份留出集已使用；继续优化前请准备新的独立留出集');
        requireTaskBuilderBinding(task);
      }
      if (kind === 'REPAIR') {
        const run = task.runs.find((r) => r.id === parsed.runId);
        const reviewRepair=!parsed.runId&&task.analysis?.standardization&&!conformancePassed(currentCandidate(task)?.conformance);
        if(!reviewRepair){
        if (
          !run ||
          run.candidateId !== task.currentCandidateId ||
          !['FAILED', 'INCOMPLETE'].includes(run.status)
        )
          bundleError('请选择当前候选的失败验收记录');
        if (run.phase === 'holdout')
          bundleError('独立留出验收记录不提供给修复 Agent，请使用开发回归案例重现问题');
        if(run.cases.some(c=>c.failureStage==='JUDGE'))
          bundleError('评审服务未完成评分，请先修复评审服务后重新验收，不应据此修改候选');
        if(run.cases.some(c=>c.failureStage==='RUNTIME'))
          bundleError('Runtime 未完成可信执行，请先排查启动、模型连接和证据，再重新验收');
        if(!hasCandidateFailures(run))bundleError('尚有要求未验证，请补充测试；没有候选失败证据，不应据此修改代码');
        }
      }
      if (kind === 'ACCEPT') {
        if(task.configuration){const issues=runtimeInputIssues(task,task.configuration,true);if(issues.length)bundleError(issues.join('；'));}
        if(task.analysis?.standardization&&!conformancePassed(currentCandidate(task)?.conformance))bundleError('候选尚未通过标准化审查，请先修复');
        requireTaskBuilderBinding(task);
        if (!task.currentCandidateId || !task.configuration || !task.suite)
          bundleError('请先生成候选、配置环境并保存验收用例');
        if (parsed.phase === 'holdout' && !task.suite.holdoutCases?.length)
          bundleError('尚未配置独立留出案例');
      }
      MigrationTaskService.executing++;
      reserved = true;
      task.attempts.push({
        id: 'attempt-' + randomUUID(),
        kind,
        ...(optimizationGoal?{optimizationGoal}:{}),
        ...(kind==='OPTIMIZE'?{optimizationInputs:{suiteDigest:canonicalSha256(task.suite),planDigest:canonicalSha256(task.analysis??null),judgeDigest:this.judge.identity?.()}}:{}),
        requestId,
        ...(!['ACCEPT','BASELINE'].includes(kind) ? { agentRunId: 'agent-' + randomUUID() } : {}),
        key: parsed.key,
        requestDigest,
        baseCandidateId: parsed.baseCandidateId,
        ...(parsed.runId ? { runId: parsed.runId } : {}),
        ...(['ANALYZE', 'PREPARE'].includes(kind) && parsed.clarification ? { clarification: parsed.clarification } : {}),
        status: 'RUNNING',
        startedAt: new Date().toISOString(),
        message: kind === 'ACCEPT' ? '准备整组联合验收' : '准备完整工作区',
      });
    }).catch((error) => {
      if (reserved) MigrationTaskService.executing--;
      throw error;
    });
    if (duplicate) return task;
    const attempt = parsed.resumeAttemptId?task.attempts.find(a=>a.id===parsed.resumeAttemptId)!:task.attempts[task.attempts.length - 1]!;
    this.logger?.info({
      event: 'bundle_operation_started', taskId: id, attemptId: attempt.id, requestId: attempt.requestId, agentRunId: attempt.agentRunId,
      kind, candidateId: attempt.baseCandidateId
    });
    const done = this.execute(task, attempt, parsed.phase, signal,agents).finally(() => {
      MigrationTaskService.executing--;
    });
    trackExecution(done);
    return task;
  }
  private async progress(id: string, attemptId: string, message: string) {
    this.activity?.emit('progress',message);
    await this.update(id, (task) => {
      const attempt = task.attempts.find((a) => a.id === attemptId)!;
      attempt.message = message;
    });
  }
  private execute(task: BundleTask, attempt: BundleAttempt, phase: 'development' | 'holdout', signal: AbortSignal,agents?:ImprovementAgents) {
    const work = () => this.executeOperation(task, attempt, phase, signal,true,undefined,agents);
    return this.activity ? this.activity.run(task.id, work, {
      signal, taskId: attempt.id,
      terminalStatus: async () => {const status=(await this.repository.get(task.id)).attempts.find(a => a.id === attempt.id)!.status;return status==='WAITING'?'COMPLETED':status;},
    }) : work();
  }
  private async executeOperation(
    task: BundleTask,
    attempt: BundleAttempt,
    phase: 'development' | 'holdout',
    signal: AbortSignal,
    promote=true,
    diagnosis?:unknown,
    agents?:ImprovementAgents,
  ) {
    try {
      signal.throwIfAborted();
      if(attempt.kind==='OPTIMIZE'){
        const state=await optimizeMigrationTask(task,attempt,{
          get:()=>this.repository.get(task.id),snapshot:id=>this.readSnapshot(task.id,id),
          activate:runId=>this.update(task.id,t=>{const run=t.runs.find(r=>r.id===runId);if(!run)bundleError('缺少评测上下文');activateOptimizationRun(t,run);}).then(()=>{}),
          save:state=>this.update(task.id,t=>{const a=t.attempts.find(a=>a.id===attempt.id)!;a.optimization=state;a.message=`第 ${state.rounds.length} / ${state.goal.maxRounds} 轮 · ${state.stage}${state.reason?' · '+state.reason:''}`;}).then(()=>{}),
          adjust:async(current,runId,diagnosis,childSignal)=>{
            const child:BundleAttempt={id:'attempt-'+randomUUID(),kind:'REPAIR',key:randomUUID(),requestDigest:randomUUID(),
              baseCandidateId:current.currentCandidateId,runId,agentRunId:'agent-'+randomUUID(),status:'RUNNING',startedAt:new Date().toISOString(),message:'优化候选调整'};
            await this.update(task.id,t=>{t.attempts.push(child);});
            await this.executeOperation(current,child,'development',childSignal,false,diagnosis);
            const updated=await this.repository.get(task.id),completed=updated.attempts.find(a=>a.id===child.id)!;
            if(completed.status!=='COMPLETED'||!completed.resultCandidateId)bundleError(completed.error??'候选调整未完成');
            return updated.candidates.find(c=>c.id===completed.resultCandidateId)!;
          },
          evaluate:async(current,childSignal)=>{
            requireTaskBuilderBinding(current);
            await acceptMigrationTask({update:this.update.bind(this),readSnapshot:this.readSnapshot.bind(this),progress:this.progress.bind(this),runtime:this.runtime,judge:this.judge,logger:this.logger},current,attempt,'development',childSignal);
            const updated=await this.repository.get(task.id),runId=updated.attempts.find(a=>a.id===attempt.id)!.runId;
            return updated.runs.find(r=>r.id===runId)!;
          },
        },agents!,signal);
        if(['FAILED','CANCELLED'].includes(state.status))bundleError(state.reason??'优化未完成');
        if(state.status==='WAITING'){
          await this.update(task.id,t=>{const a=t.attempts.find(a=>a.id===attempt.id)!;a.status='WAITING';a.message=state.reason??'等待外部调整';delete a.finishedAt;});
          return;
        }
      }
      else if (attempt.kind === 'ACCEPT' || attempt.kind === 'BASELINE') await acceptMigrationTask({ update: this.update.bind(this), readSnapshot: this.readSnapshot.bind(this), progress: this.progress.bind(this), runtime: this.runtime, judge: this.judge, logger: this.logger }, task, attempt, phase, signal, attempt.kind === 'BASELINE' ? 'baseline' : 'candidate');
      else {
        const source = await this.readSnapshot(task.id, null),
          base = await this.readSnapshot(task.id, attempt.baseCandidateId ?? task.preparations?.at(-1)?.id ?? null);
        const prior = task.runs.find((run) => run.id === attempt.runId);
        // Only development observations reach the code agent, never any holdout suite.
        const feedback = prior
          ? {
            cases: prior.cases,
            inputs: simpleMigrationCases(prior.suite).map((c) => ({
              id: c.caseId,
              input: c.prompt,
              workspaceFiles: c.workspaceFiles,
              turns: c.turns,
            })),
            configuration: {
              environmentId: prior.configuration.environmentId,
              modelId: prior.configuration.modelId,
            },
          }
          : attempt.kind==='REPAIR'?{conformance:currentCandidate(task)?.conformance}:undefined;
        await this.progress(
          task.id,
          attempt.id,
          attempt.kind === 'ANALYZE'
            ? 'Agent 正在分析整组 Skill 与共享源码'
            : 'Agent 正在完整工作区改造，可跨 Skill 修改',
        );
        // Preparation can outlive cancellation. Do not hand an already-aborted
        // signal to a new agent whose abort listener has not been registered yet.
        signal.throwIfAborted();
        const result = await this.agent({
          onComposition: receipt => this.update(task.id, t => {
            const current = t.attempts.find(a => a.id === attempt.id)!;
            current.agentCompositions = [...(current.agentCompositions ?? []).filter(c => c.role !== receipt.role), receipt];
          }).then(() => {}),
          correlation: { taskId: task.id, attemptId: attempt.id, requestId: attempt.requestId, agentRunId: attempt.agentRunId! },
          mode: attempt.kind,
          ...(task.inputKind === 'agent_project' ? { project: { notes: task.projectNotes ?? '', preparation: task.preparations?.at(-1)?.report } } : {}),
          ...(diagnosis?{adjustmentCapabilities:['document','tool','runtime'] as Array<'document'|'tool'|'runtime'>}:{}),
          source,
          base,
          goal: task.goal,
          target: task.target,
          analysis: task.analysis,
          clarification: attempt.clarification,
          feedback:diagnosis?{...feedback,diagnosis}:feedback,
          signal,
        });
        signal.throwIfAborted();
        if (result.status !== 'PRODUCED') bundleError(result.reason ?? 'Agent 需要补充信息');
        if (attempt.kind === 'PREPARE') {
          const report = projectPreparationSchema.parse(result.preparation);
          if (!result.files) bundleError('Agent 没有返回工程文件');
          const prepared = projectSnapshot(result.files);
          for (const skill of report.skills) if (!(skill.path in prepared.files)) bundleError('识别的 Skill 文件不存在：' + skill.path);
          const executions = z.array(projectExecutionReceiptSchema).parse(result.executions ?? []);
          const id = 'candidate-' + randomUUID();
          await this.repository.saveSnapshot(task.id, id, prepared);
          await this.update(task.id, t => {
            signal.throwIfAborted();
            (t.preparations ??= []).push({id, attemptId: attempt.id, digest: prepared.digest,
              createdAt: new Date().toISOString(), report, executions, baselineStatus: 'NOT_EVALUATED'});
            // A preparation changes the working input; earlier plans remain in history.
            delete t.analysis;
            delete t.planRevisionId;
            delete t.planApproved;
          });
        } else if (attempt.kind === 'ANALYZE') {
          const analysis = analysisSchema.parse(result.analysis);
          const standardIssues=standardizationIssues(analysis,base.files);
          if(standardIssues.length)bundleError('标准化方案检查失败：'+standardIssues.join('；'));
          if(analysis.diagnosis){
            const d=analysis.diagnosis,ids=new Set(d.tools.map(tool=>tool.id)),members=new Set(base.members.map(member=>member.id));
            if(ids.size!==d.tools.length || new Set(d.dependencies.map(dep=>dep.id)).size!==d.dependencies.length) bundleError('工具诊断含重复标识');
            if([...d.skillChanges,...d.tools].some(item=>item.memberIds.some(id=>!members.has(id)))) bundleError('工具诊断引用了工程之外的 Skill');
            if(d.dependencies.some(dep=>dep.toolIds.some(id=>!ids.has(id)))) bundleError('依赖引用了未识别的工具');
            const resolve=(file:string)=>sourceEvidencePath(file,base.files)??bundleError('工具诊断引用了不存在或不唯一的源文件');
            for(const item of d.skillChanges)item.paths=item.paths.map(resolve);
            for(const tool of d.tools)tool.sourcePaths=tool.sourcePaths.map(resolve);
            if(base.members.some(member=>!d.skillChanges.some(item=>item.paths.includes(member.skillFile)))) bundleError('工具诊断遗漏了工程中的 Skill 指令');
            const claims=[...d.dependencies.flatMap(dep=>dep.evidence),...d.tools.flatMap(tool=>[...tool.evidence,...tool.callChain.flatMap(node=>node.evidence)])];
            const issues=evidenceIssues(claims,Object.fromEntries(Object.entries(base.files).map(([name,encoded])=>[name,Buffer.from(encoded,'base64').toString('utf8')])));
            if(issues.length) bundleError('工具诊断源码依据无法核对：'+issues.join('；'));
          }
          if(analysis.plan) {
            const plan=analysis.plan;
            for(const ids of [plan.changes.map(item=>item.id),plan.dependencies.map(item=>item.key),plan.acceptanceChecks.map(item=>item.id),plan.requiredCapabilities.map(item=>item.id)])
              if(new Set(ids).size!==ids.length) bundleError('迁移方案中存在重复的条目标识');
            const memberIds=new Set(base.members.map(member=>member.id));
            if([...plan.changes,...plan.dependencies,...plan.sourceCouplings,...plan.acceptanceChecks,...(analysis.standardization?.requirements??[])].some(item=>item.memberIds.some(id=>!memberIds.has(id))))
              bundleError('迁移方案引用了工程之外的 Skill');
            const evidence=[...plan.changes,...plan.sourceCouplings].flatMap(item=>item.evidence);
            const issues=evidenceIssues(evidence,Object.fromEntries(Object.entries(base.files).map(([name,encoded])=>[name,Buffer.from(encoded,'base64').toString('utf8')])));
            if(issues.length) bundleError('方案源码依据无法核对：'+issues.join('；'));
          }
          await this.update(task.id, (t) => {
            if(t.analysis && !t.planRevisionId) {
              const previous={id:'plan-'+randomUUID(),digest:canonicalSha256(t.analysis),analysis:structuredClone(t.analysis),baseCandidateId:t.currentCandidateId,createdAt:t.createdAt};
              (t.planRevisions ??= []).push(previous);
              const candidate=currentCandidate(t);if(candidate&&!candidate.planRevisionId)candidate.planRevisionId=previous.id;
            }
            const revision={id:'plan-'+randomUUID(),digest:canonicalSha256(analysis),analysis:structuredClone(analysis),baseCandidateId:attempt.baseCandidateId,
              createdAt:new Date().toISOString(),...(attempt.clarification?{clarification:attempt.clarification}:{})};
            (t.planRevisions ??= []).push(revision);t.planRevisionId=revision.id;
            t.analysis = analysis;
          });
        } else {
          const delivery = deliverySchema.parse(result.delivery);
          if (!result.files) bundleError('Agent 没有交付完整候选文件');
          const deliveryIssues=task.analysis?standardDeliveryIssues(task.analysis,delivery,result.files):[];
          if(deliveryIssues.length)bundleError('交付契约检查失败：'+deliveryIssues.join('；'));
          const revision = snapshot(result.files, 'r' + (task.candidates.length + 1), base.members.length ? base : undefined);
          for (const service of delivery.services)
            for (const file of service.filePaths)
              if (!(file in revision.files)) bundleError('服务交付文件缺失：' + file);
          const toolNames = delivery.services.flatMap((s) => s.toolNames);
          if (new Set(toolNames).size !== toolNames.length) bundleError('共享服务工具名称冲突');
          const candidate = {
            id: 'candidate-' + randomUUID(),
            parentId: attempt.baseCandidateId,
            createdAt: new Date().toISOString(),
            digest: revision.digest,
            members: revision.members,
            summary: delivery.summary,
            planRevisionId: task.planRevisionId,
            services: delivery.services,
            ...(delivery.tools?{tools:delivery.tools}:{}),
            ...(delivery.conformance?{conformance:delivery.conformance}:{}),
            ...(delivery.contractEvidence?{contractEvidence:delivery.contractEvidence}:{}),
            diff: bundleDiff(base.files, revision.files),
            checks: ['MEMBER_ENTRIES', 'FRONTMATTER', 'PATHS', 'TOOL_NAMES'],
          };
          await this.progress(task.id, attempt.id, '文件及成员清单检查通过，正在冻结整组候选');
          signal.throwIfAborted();
          await this.repository.saveSnapshot(task.id, candidate.id, revision);
          await this.update(task.id, (t) => {
            signal.throwIfAborted();
            t.candidates.push(candidate);
            t.attempts.find(a=>a.id===attempt.id)!.resultCandidateId=candidate.id;
            if(promote)t.currentCandidateId = candidate.id;
          });
        }
      }
      await this.update(task.id, (t) => {
        const a = t.attempts.find((a) => a.id === attempt.id)!;
        a.status = 'COMPLETED';
        a.finishedAt = new Date().toISOString();
        a.message = attempt.kind === 'ACCEPT' ? '联合验收已结束，请查看验收结论' : '本阶段已完成';
      });
      this.logger?.info({
        event: 'bundle_operation_finished', taskId: task.id, attemptId: attempt.id, requestId: attempt.requestId, agentRunId: attempt.agentRunId,
        kind: attempt.kind, status: 'COMPLETED', elapsedMs: Date.now() - Date.parse(attempt.startedAt)
      });
    } catch (error) {
      this.logger?.warn({
        event: 'bundle_operation_finished', taskId: task.id, attemptId: attempt.id, requestId: attempt.requestId, agentRunId: attempt.agentRunId,
        kind: attempt.kind, status: signal.aborted ? 'CANCELLED' : 'FAILED',
        elapsedMs: Date.now() - Date.parse(attempt.startedAt), err: operationalError(error)
      });
      await this.update(task.id, (t) => {
        const a = t.attempts.find((a) => a.id === attempt.id)!;
        a.status = signal.aborted ? 'CANCELLED' : 'FAILED';
        a.finishedAt = new Date().toISOString();
        a.error = error instanceof Error ? error.message : '操作失败';
        a.message = signal.aborted ? '操作已取消' : '操作未完成';
        for (const run of t.runs)
          if (run.status === 'RUNNING') {
            run.status = signal.aborted ? 'CANCELLED' : 'INCOMPLETE';
            run.finishedAt = new Date().toISOString();
          }
      });
    }
  }
  async cancel(id: string) {
    await this.get(id);
    const operations = [...this.operations].filter(operation => operation.taskId === id);
    for (const operation of operations) operation.controller.abort(new Error('用户取消'));
    const results = await Promise.allSettled(operations.map(operation => operation.done));
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    await this.update(id,task=>{
      const waiting=waitingOptimization(task);if(!waiting)return;
      const loop=waiting.optimization!,run=task.runs.find(r=>r.id===loop.bestEvaluationId);
      if(run)activateOptimizationRun(task,run);
      waiting.status='CANCELLED';waiting.finishedAt=new Date().toISOString();waiting.message='已停止等待，实验和 Builder 交付历史已保留';
      loop.status='CANCELLED';loop.reason=waiting.message;loop.finishedAt=waiting.finishedAt;
    });
    return this.get(id);
  }
  async selectOptimization(id:string,input:unknown){
    const {attemptId}=z.strictObject({attemptId:z.string().min(1)}).parse(input);
    return this.update(id,task=>{
      this.idle(task);
      const loop=task.attempts.find(a=>a.id===attemptId)?.optimization;
      if(!loop||loop.status!=='REVIEW'||loop.bestEvaluationId===loop.baselineEvaluationId||task.currentCandidateId!==loop.baseline.id)bundleError('没有可选择的审查通过候选，或基线已经变化');
      const run=task.runs.find(r=>r.id===loop.bestEvaluationId);
      if(!run||run.configurationDigest!==canonicalSha256(task.configuration)||run.suiteDigest!==canonicalSha256(task.suite)
        ||run.judgeDigest!==this.judge.identity?.()||run.runtimeSelectionRevision!==task.runtimeSelectionRevision
        ||task.candidates.find(c=>c.id===loop.best.id)?.planRevisionId!==task.planRevisionId)bundleError('评测条件已变化，请重新验证候选');
      task.currentCandidateId=loop.best.id;
    });
  }
  async close() {
    this.closing = true;
    const active = [...this.operations];
    for (const task of active) task.controller.abort(new Error('服务正在关闭'));
    await Promise.allSettled(active.map((t) => t.done));
  }
  async files(id: string, candidateId: string | null, name: string) {
    const bundle = await this.readSnapshot(id, candidateId);
    return { path: name, content: readText(bundle.files, name) };
  }
  async optimizationWorkspace(id:string,attemptId:string){
    const task=await this.repository.get(id),attempt=task.attempts.find(a=>a.id===attemptId),loop=attempt?.optimization;
    if(!loop)bundleError('优化任务不存在',404);
    const candidate=loop.waiting?.candidate??loop.working??loop.best;
    const snapshot=await this.readSnapshot(id,candidate.id);
    const metadata={candidate,diagnosis:loop.rounds.at(-1)?.diagnosis,goal:loop.goal,requestId:loop.waiting?.requestId};
    const files={...snapshot.files,'optimization-handoff.json':Buffer.from(JSON.stringify(metadata,null,2)).toString('base64')};
    assertMigrationExportSafe(Object.fromEntries(Object.entries(files).map(([path,value])=>[path,Buffer.from(value,'base64')])));
    return bundleZip(files);
  }
  export(id: string, verified = false) { return exportMigrationTask(this.repository, this.runtime, id, verified, this.judge.identity?.()); }
}
