import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { evalCaseSchema, fingerprint } from "../contracts.js";
import type { RuntimeAdapter } from "../adapters.js";
import type { EvalPack } from "../contracts.js";
import { DirectModelRuntimeAdapter } from "../direct-model-runtime.js";
import type { RuntimeEnvironmentDescriptor } from "../http-runtime.js";
import { DeterministicRubricJudge, ModelCandidateJudge, ModelPairwiseJudge, type PairwiseJudge } from "../judge.js";
import { ReplayRuntimeAdapter } from "../replay.js";
import { SideRuntimeAdapter } from '../side-runtime.js';
import { EvaluationCancelledError, runEvaluation } from "../runner.js";
import { configuredModelRole } from "./config.js";
import { runConfigurationSchema, type EnvironmentRecord, type RunConfiguration } from "./contracts.js";
import type { EvalPackCatalog } from "./catalog.js";
import type { EnvironmentStore } from "./environment-store.js";
import { EvaluationJobStore, type EvaluationJob, type FrozenQuestionSet } from "./job-store.js";
import { generateRunQuestions } from "./run-questions.js";
import type { PreparationStore } from "./preparation-store.js";
import type { SkillStore } from "./skill-store.js";
import { canonicalNeutralArchive } from './neutral-archive.js';
import { CandidateAssessmentRuntimeAdapter } from '../candidate-assessment-runtime.js';
import {ModelGoalJudge} from '../goal-judge.js';
import {ModelRuntimeComparisonJudge} from '../runtime-comparison-judge.js';
import {OriginalServiceRuntimeAdapter} from '../original-service-runtime.js';
import {ModelServiceComparisonJudge} from '../service-comparison-judge.js';
import {RuntimeLauncherAdapter} from '../runtime-launcher.js';
import {zipSync} from 'fflate';

type RunManagerOptions = {
  catalog: EvalPackCatalog;
  preparations: PreparationStore;
  skills: SkillStore;
  environments: EnvironmentStore;
  jobs: EvaluationJobStore;
  maxConcurrentRuns: number;
  resolveMigrationRuntime?:(runtimeId:string)=>Promise<EnvironmentRecord|null>;
  resolveServiceEnvironment?:(reference:{migrationId:string;revision:number;assetDigest:string;configurationDigest:string},toolNames:string[])=>Promise<{configuration:Record<string,string>;secrets:Record<string,string>}>;
};

export function findMissingRequiredTools(
  requiredTools: string[],
  mcpServers: RuntimeEnvironmentDescriptor["mcpServers"] = [],
  commandScripts: RuntimeEnvironmentDescriptor["commandScripts"] = [],
): string[] {
  const availableTools = new Set([...mcpServers.flatMap(server => server.toolNames),...commandScripts.map(tool=>tool.name)]);
  return requiredTools.filter(toolName => !availableTools.has(toolName));
}

function stageLabel(stage: string): string {
  if (stage === "preparing") return "环境预检与候选准备";
  if (stage === "executing") return "左右候选同步执行";
  if (stage === "judging") return "匿名专业 Judge 评阅";
  return "评测完成";
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/动态出题/u.test(message)) return "QUESTION_GENERATION_FAILED";
  if (/preflight|health|environment/iu.test(message)) return "ENVIRONMENT_PREFLIGHT_FAILED";
  if (/credential|api key|model/iu.test(message)) return "MODEL_CONFIGURATION_FAILED";
  if (/tool/iu.test(message)) return "RUNTIME_TOOL_SUPPORT_REQUIRED";
  return "EVALUATION_EXECUTION_FAILED";
}

export class EvaluationRunManager {
  private readonly queue: string[] = [];
  private readonly active = new Map<string, AbortController>();
  private readonly events = new EventEmitter();

  constructor(private readonly options: RunManagerOptions) {
    this.events.setMaxListeners(200);
  }

  subscribe(jobId: string, listener: (job: EvaluationJob) => void): () => void {
    const event = `job:${jobId}`;
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  async create(input: unknown, frozenQuestions?: FrozenQuestionSet): Promise<EvaluationJob> {
    const configuration = runConfigurationSchema.parse(input);
    const now = new Date().toISOString();
    const job: EvaluationJob = {
      schemaVersion: "finance.skill-eval.job.v1",
      jobId: `run-${randomUUID()}`,
      status: "queued",
      stageLabel: "等待执行资源",
      configuration,
      ...(frozenQuestions ? { questionSet: structuredClone(frozenQuestions) } : {}),
      pack: null,
      progress: { completedRuns: 0, totalRuns: 0 },
      evidence: [],
      report: null,
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      updatedAt: now,
    };
    await this.options.jobs.save(job);
    this.queue.push(job.jobId);
    this.emit(job);
    void this.pump();
    return job;
  }

  async retry(jobId: string): Promise<EvaluationJob> {
    const existing = this.options.jobs.get(jobId);
    if (!existing) throw new Error(`Unknown evaluation run: ${jobId}`);
    if (!["failed", "cancelled", "interrupted"].includes(existing.status)) {
      throw new Error("只有失败、已取消或已中断的运行可以重试");
    }
    return this.create(existing.configuration, existing.questionSet);
  }

  async cancel(jobId: string): Promise<EvaluationJob> {
    const job = this.options.jobs.get(jobId);
    if (!job) throw new Error(`Unknown evaluation run: ${jobId}`);
    const queuedIndex = this.queue.indexOf(jobId);
    if (queuedIndex >= 0) this.queue.splice(queuedIndex, 1);
    this.active.get(jobId)?.abort();
    if (["completed", "failed", "cancelled", "interrupted"].includes(job.status)) return job;
    job.status = "cancelled";
    job.stageLabel = "已取消";
    job.error = null;
    job.completedAt = new Date().toISOString();
    await this.options.jobs.save(job);
    this.emit(job);
    return job;
  }

  private emit(job: EvaluationJob): void {
    this.events.emit(`job:${job.jobId}`, job);
  }

  private async pump(): Promise<void> {
    while (this.active.size < this.options.maxConcurrentRuns && this.queue.length > 0) {
      const jobId = this.queue.shift();
      if (!jobId) return;
      const job = this.options.jobs.get(jobId);
      if (!job || job.status !== "queued") continue;
      const controller = new AbortController();
      this.active.set(jobId, controller);
      void this.execute(job, controller)
        .finally(() => {
          this.active.delete(jobId);
          void this.pump();
        });
    }
  }

  private async resolvePack(configuration: RunConfiguration): Promise<EvalPack> {
    let pack: EvalPack | null = null;
    if (configuration.packId) pack = this.options.catalog.get(configuration.packId);
    if (configuration.preparationId) {
      const preparation = await this.options.preparations.get(configuration.preparationId);
      if (!preparation) throw new Error(`Unknown prepared evaluation: ${configuration.preparationId}`);
      const analyzer = configuredModelRole("ANALYZER");
      const execution = configuredModelRole("EXECUTION");
      const judge = configuredModelRole("JUDGE");
      pack = this.options.preparations.buildPack({
        preparation,
        analyzerModel: analyzer.model,
        executionModel: execution.model,
        judgeModel: judge.model,
      });
    }
    if (!pack) throw new Error("评测题集不可用");
    const selected = configuration.selectedCaseIds.length
      ? pack.cases.filter(evalCase => configuration.selectedCaseIds.includes(evalCase.caseId))
      : [...pack.cases];
    if (selected.length === 0) throw new Error("没有选择任何评测用例");
    if (configuration.includeHoldout) {
      const holdout = pack.holdoutCases;
      if (!Array.isArray(holdout) || !holdout.length) throw new Error("这个评测题集没有冻结的留出题");
      selected.push(...holdout.map(item => evalCaseSchema.parse(item)));
    }
    const executionModel = configuration.executionModel
      ?? (configuration.runtime.type === "direct_model" ? configuredModelRole("EXECUTION").model : null);
    return {
      ...pack,
      cases: selected,
      variants: {
        left: configuration.leftVariant ?? pack.variants.left,
        right: configuration.rightVariant ?? pack.variants.right,
      },
      models: {
        ...pack.models,
        execution: {
          left: configuration.leftExecutionModel ?? executionModel ?? pack.models.execution.left,
          right: configuration.rightExecutionModel ?? executionModel ?? pack.models.execution.right,
        },
        judge: configuration.judgeModel
          ?? (configuration.judgeMode === "model" ? configuredModelRole("JUDGE").model : pack.models.judge),
      },
    };
  }

  private async skillResolver(assetId: string | undefined, strict = false, neutral = false, executablePaths:string[] = [],completeArchive=false) {
    const assets = await this.options.skills.list();
    return async (variant: EvalPack["variants"]["left"]) => {
      if (variant.mode !== "skill_version") return null;
      const matches = assets.filter(item => item.skillId === variant.skillId && item.version === variant.version
        && (!variant.artifactSha256 || item.artifactSha256 === variant.artifactSha256));
      const asset = matches.find(item => item.assetId === assetId) ?? (!strict && matches.length === 1 ? matches[0] : null);
      if (!asset) throw new Error(`Skill artifact unavailable or ambiguous: ${variant.skillId}@${variant.version}`);
      let canonicalArchive:string|undefined,archive:Record<string,Uint8Array>|undefined,archiveBase64:string|undefined,archiveSha256:string|undefined;
      const files=await this.options.skills.readFiles(asset.assetId);
      if (strict) {
        archive=await this.options.skills.readArchive(asset.assetId);
        if(completeArchive){const bytes=Buffer.from(zipSync(archive));archiveBase64=bytes.toString('base64');archiveSha256=createHash('sha256').update(bytes).digest('hex');}
        if(neutral&&archive['migration-generated/neutral-contract.json'])canonicalArchive=canonicalNeutralArchive(archive,asset.artifactSha256);
        else for(const [name,bytes] of Object.entries(archive)){
          try{files[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
          catch{if(!completeArchive)throw new Error(`Migration dependency mapping required for non-text file: ${name}`);}
        }
      }
      if(executablePaths.length){archive??=await this.options.skills.readArchive(asset.assetId);for(const name of executablePaths){
        const bytes=archive[name];if(!bytes)throw new Error(`Bound Script Tool file is unavailable: ${name}`);
        try{files[name]=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error(`Bound Script Tool must be UTF-8 text: ${name}`);}
      }}
      return {
        skillId: asset.skillId,
        version: asset.version,
        artifactSha256: asset.artifactSha256,
        instructions: await this.options.skills.readSource(asset.assetId),
        files,
        ...(canonicalArchive?{canonicalArchive}:{}),
        ...(archiveBase64?{archiveBase64}:{}),
        ...(archiveSha256?{archiveSha256}:{}),
      };
    };
  }

  private async runtimeFor(configuration: RunConfiguration, pack: EvalPack): Promise<RuntimeAdapter> {
    if (configuration.runtimeBindings) {
      const makeSide = async (side: 'left' | 'right') => {
        const binding = configuration.runtimeBindings![side];
        const selectedEnvironment = await this.options.resolveMigrationRuntime?.(binding.environmentId);
        if (!selectedEnvironment) throw new Error('迁移执行环境不可用');
        const environment=selectedEnvironment.type==='runtime_launcher'?selectedEnvironment:(await this.options.environments.resolveLauncher(selectedEnvironment)).launcher;
        const services=await Promise.all((configuration.runtimeMcpBindings?.[side]??[]).map(async service=>{
          const {environmentReference,...launch}=service;
          if(!environmentReference)return launch;
          if(!this.options.resolveServiceEnvironment)throw new Error('服务配置解析器不可用');
          if(environmentReference.assetDigest!==service.assetDigest)throw new Error('服务配置与候选资产不一致');
          const resolved=await this.options.resolveServiceEnvironment(environmentReference,service.toolNames);
          return {...launch,environment:resolved.configuration,secretEnvironment:resolved.secrets};
        }));
        if(services.some(service=>pack.variants[side].mode!=='skill_version'||service.assetDigest!==(pack.variants[side] as {artifactSha256?:string}).artifactSha256))throw new Error('Candidate MCP asset digest does not match the bound Skill');
        const executablePaths=[...new Set([...(configuration.runtimeCommandBindings?.[side]??[]).flatMap(tool=>[tool.path,...tool.filePaths]),...services.flatMap(service=>service.filePaths)])];
        const resolveSkill = await this.skillResolver(binding.skillAssetId,true,true,executablePaths,true);
        const skill=await resolveSkill(pack.variants[side]);
        const descriptor=await this.environmentDescriptor(selectedEnvironment,[...new Set(pack.cases.flatMap(c=>c.requiredTools))],configuration.runtimeCommandBindings?.[side]??[],services,pack.metadata.assessmentMode==='natural_language',configuration.runtimeHarnessTools,true);
        if(configuration.runtimeToolConfig){
          descriptor.runtimeToolConfig=configuration.runtimeToolConfig;
        }
        return new RuntimeLauncherAdapter({baseUrl:environment.baseUrl,headers:this.options.environments.headers(environment),side,
          model:pack.models.execution[side],variant:pack.variants[side],skill,environment:descriptor,timeoutMs:configuration.timeoutMs});
      };
      if(configuration.evaluationMode==='candidate_assessment')return makeSide('right');
      if(configuration.evaluationMode==='service_comparison'){
        const variant=pack.variants.left;
        if(variant.mode!=='skill_version'||!variant.artifactSha256)throw Error('原服务对比缺少源资产绑定');
        return new SideRuntimeAdapter({left:new OriginalServiceRuntimeAdapter(configuration.originalService!,variant.artifactSha256),right:await makeSide('right')});
      }
      return new SideRuntimeAdapter({left:await makeSide('left'),right:await makeSide('right')});
    }
    if (configuration.runtime.type === "replay") {
      if (!pack.cases.every(evalCase => Boolean(evalCase.replay))) {
        throw new Error("所选用例没有提供冻结的回放证据");
      }
      return new ReplayRuntimeAdapter(pack);
    }
    const resolveSkill = await this.skillResolver(configuration.skillAssetId, false, false,[]);
    if (configuration.runtime.type === "direct_model") {
      const execution = configuredModelRole("EXECUTION");
      if (!execution.adapter) throw new Error("本服务未配置执行模型");
      if (!configuration.skillAssetId) {
        throw new Error("直连模型运行需要先上传 Skill 资产");
      }
      if (pack.cases.some(evalCase => evalCase.requiredTools.length > 0)) {
        throw new Error("这个测试需要工具，请选择 Agent Runtime HTTP 环境");
      }
      return new DirectModelRuntimeAdapter({ modelAdapter: execution.adapter, resolveSkill });
    }
    if(configuration.runtime.type==='runtime_launcher'){
      const selectedEnvironment=await this.options.environments.get(configuration.runtime.environmentId);
      if(!selectedEnvironment)throw new Error('所选执行环境不可用');
      const launcher=selectedEnvironment.type==='runtime_launcher'?selectedEnvironment:(await this.options.environments.resolveLauncher(selectedEnvironment)).launcher;
      const inspection=await this.options.environments.inspect(selectedEnvironment);
      if(inspection.status!=='ready'||!inspection.capabilities)throw new Error(inspection.error??'执行环境预检失败');
      const available=new Set(inspection.capabilities.models.map(model=>model.modelId));
      for(const side of ['left','right'] as const)if(!available.has(pack.models.execution[side].modelId))throw new Error(`所选 ${side==='left'?'左侧':'右侧'} 模型不属于这个执行环境`);
      const descriptor=await this.environmentDescriptor(selectedEnvironment,[...new Set(pack.cases.flatMap(evalCase=>evalCase.requiredTools))],[],[],false,configuration.runtimeHarnessTools,true);
      if(configuration.runtimeToolConfig)descriptor.runtimeToolConfig=configuration.runtimeToolConfig;
      const makeSide=async(side:'left'|'right')=>new RuntimeLauncherAdapter({
        baseUrl:launcher.baseUrl,headers:this.options.environments.headers(launcher),side,
        model:pack.models.execution[side],variant:pack.variants[side],skill:await resolveSkill(pack.variants[side]),
        environment:structuredClone(descriptor),timeoutMs:configuration.timeoutMs,
      });
      return new SideRuntimeAdapter({left:await makeSide('left'),right:await makeSide('right')});
    }
    throw new Error(`Unsupported runtime type: ${configuration.runtime satisfies never}`);
  }

  private async environmentDescriptor(
    runtimeEnvironment: EnvironmentRecord,
    requiredTools: string[],
    commandScripts:NonNullable<RuntimeEnvironmentDescriptor['commandScripts']>=[],
    candidateMcpServices:NonNullable<RuntimeEnvironmentDescriptor['candidateMcpServices']>=[],
    exposeAllCandidateTools=false,
    harnessToolNames:NonNullable<RuntimeEnvironmentDescriptor['harnessToolNames']>=[],
    inlineExternalSecrets=false,
  ): Promise<RuntimeEnvironmentDescriptor> {
    const candidateNames=new Set(candidateMcpServices.flatMap(service=>service.toolNames));
    const scriptNames=new Set(commandScripts.map(tool=>tool.name));
    const nativeNames = new Set<string>();
    if (runtimeEnvironment.type === 'runtime_launcher' && requiredTools.some(name =>
        !candidateNames.has(name) && !scriptNames.has(name) && !harnessToolNames.includes(name as typeof harnessToolNames[number]) && name !== 'skill_tool')) {
      const preflight = await this.options.environments.preflight(runtimeEnvironment);
      if (preflight.status !== 'ready') throw new Error(`Runtime Launcher preflight failed: ${preflight.error ?? 'unknown'}`);
      if ('capabilities' in preflight) {
        for (const name of preflight.capabilities?.nativeToolNames ?? []) nativeNames.add(name);
      }
    }
    const externalRequired=requiredTools.filter(name=>!nativeNames.has(name)&&!candidateNames.has(name)&&!scriptNames.has(name)&&!harnessToolNames.includes(name as typeof harnessToolNames[number])&&name!=='skill_tool');
    const mcpServers = [];
    for (const environmentId of externalRequired.length&&'mcpEnvironmentIds' in runtimeEnvironment ? runtimeEnvironment.mcpEnvironmentIds : []) {
      const environment = await this.options.environments.get(environmentId);
      if (!environment || environment.type !== "mcp_streamable_http") {
        throw new Error(`MCP environment is unavailable: ${environmentId}`);
      }
      const preflight = await this.options.environments.preflight(environment);
      if (preflight.status !== "ready" || !("tools" in preflight)) {
        throw new Error(`MCP preflight failed for ${environment.name}: ${preflight.error ?? "unknown"}`);
      }
      const toolNames = preflight.tools
        .map(tool => tool.name)
        .filter(toolName => externalRequired.includes(toolName));
      if (toolNames.length === 0) continue;
      mcpServers.push({
        serverId: environment.environmentId,
        endpoint: environment.endpoint,
        transport: "streamable_http" as const,
        toolNames,
        credentialEnv: environment.credentialEnv,
        ...(inlineExternalSecrets?{secretHeaders:this.options.environments.headers(environment)}:{}),
      });
    }
    const selectedScripts=commandScripts.filter(tool=>exposeAllCandidateTools||requiredTools.includes(tool.name));
    const missingTools = findMissingRequiredTools(requiredTools.filter(name=>!nativeNames.has(name)&&!candidateNames.has(name)&&!harnessToolNames.includes(name as typeof harnessToolNames[number])&&name!=='skill_tool'), mcpServers,selectedScripts);
    if (missingTools.length > 0) {
      throw new Error(`Required MCP tools are unavailable: ${missingTools.join(", ")}`);
    }
    return {
      environmentId: runtimeEnvironment.environmentId,
      requiredToolNames: requiredTools,
      harnessToolNames,
      ...(exposeAllCandidateTools?{availableToolNames:[...new Set([...scriptNames,...candidateNames])]}:{}),
      mcpServers,
      commandScripts:selectedScripts,
      candidateMcpServices:candidateMcpServices.filter(service=>exposeAllCandidateTools||service.toolNames.some(name=>requiredTools.includes(name))),
    };
  }

  private judgeFor(configuration: RunConfiguration, pack: EvalPack): PairwiseJudge {
    if (configuration.judgeMode === "deterministic") {
      if(pack.cases.some(c=>c.rubric.some(r=>r.allOf.length+r.anyOf.length+r.noneOf.length===0))) throw new Error('当前专业量表需使用模型 Judge，不支持空规则自动评分。');
      return new DeterministicRubricJudge();
    }
    const judge = configuredModelRole("JUDGE");
    if (!judge.adapter) throw new Error("本服务未配置阅卷模型");
    if(configuration.evaluationMode==='candidate_runtime_comparison')return new ModelRuntimeComparisonJudge(judge.adapter,configuration.judgeModel??pack.models.judge);
    if(configuration.evaluationMode==='service_comparison')return new ModelServiceComparisonJudge(judge.adapter,configuration.judgeModel??pack.models.judge);
    if(configuration.evaluationMode==='candidate_assessment'&&pack.metadata.assessmentMode==='natural_language')return new ModelGoalJudge(judge.adapter,configuration.judgeModel??pack.models.judge);
    return configuration.evaluationMode==='candidate_assessment'
      ?new ModelCandidateJudge(judge.adapter,configuration.judgeModel??pack.models.judge)
      :new ModelPairwiseJudge(judge.adapter, configuration.judgeModel ?? pack.models.judge);
  }

  private async execute(job: EvaluationJob, controller: AbortController): Promise<void> {
    try {
      job.status = "preparing";
      job.stageLabel = stageLabel("preparing");
      job.startedAt = new Date().toISOString();
      await this.options.jobs.save(job);
      this.emit(job);
      let pack = await this.resolvePack(job.configuration);
      controller.signal.throwIfAborted();
      if (job.configuration.caseSource === "ai_generated" || job.questionSet) {
        if (!job.questionSet) {
          job.stageLabel = "AI 正在读取 Skill 与专业参考，生成本轮试题";
          await this.options.jobs.save(job);
          this.emit(job);
          const analyzer = configuredModelRole("ANALYZER");
          if (!analyzer.adapter) throw new Error("动态出题模型未配置；可配置 Analyzer 或主动选择固定回归题。未自动回退。 ");
          const resolveSkill = await this.skillResolver(job.configuration.skillAssetId);
          const variant = pack.variants.right.mode === "skill_version" ? pack.variants.right
            : pack.variants.left.mode === "skill_version" ? pack.variants.left
            : { mode: "skill_version" as const, skillId: pack.targetSkillId, version: pack.targetSkillVersion };
          const skill = await resolveSkill(variant);
          if (!skill) throw new Error("动态出题缺少可读取的 Skill 资产");
          try {
            job.questionSet = await generateRunQuestions({
              pack, skill, adapter: analyzer.adapter, model: analyzer.model,
              count: job.configuration.generatedCaseCount, generationId: job.jobId,
              // The Analyzer adapter owns its role-specific timeout. Keeping a second, shorter
              // deadline here made slow-but-healthy models fail before that configured budget.
              signal: controller.signal,
            });
          } catch (error) {
            controller.signal.throwIfAborted();
            throw new Error(`AI 动态出题失败，未回退固定题：${error instanceof Error ? error.message : String(error)}`);
          }
        }
        controller.signal.throwIfAborted();
        const holdout = job.configuration.includeHoldout ? (pack.holdoutCases ?? []).map(item => evalCaseSchema.parse(item)) : [];
        const frozenCases = [...job.questionSet.cases, ...holdout];
        if (new Set(frozenCases.map(c => c.caseId)).size !== frozenCases.length) throw new Error("动态题与留出题 caseId 冲突，请重新准备题集");
        pack = { ...pack, cases: frozenCases, models: { ...pack.models, analyzer: job.questionSet.model } };
        job.stageLabel = `已冻结 ${pack.cases.length} 道 AI 试题，准备同题 A/B 执行`;
        await this.options.jobs.save(job);
        this.emit(job);
      }
      pack.packFingerprint = fingerprint({ base: pack.packFingerprint, cases: pack.cases, variants: pack.variants, models: pack.models });
      job.pack = {
        packId: pack.packId,
        version: pack.version,
        targetSkillId: pack.targetSkillId,
        targetSkillVersion: pack.targetSkillVersion,
        caseCount: pack.cases.length,
      };
      job.progress.totalRuns = pack.cases.length * 2;
      await this.options.jobs.save(job);
      let runtime = await this.runtimeFor(job.configuration, pack);
      if(job.configuration.evaluationMode==='candidate_assessment')runtime=new CandidateAssessmentRuntimeAdapter(runtime,pack.variants.right,pack.models.execution.right);
      controller.signal.throwIfAborted();
      const judge = this.judgeFor(job.configuration, pack);
      let lastLivePublishedAt = 0;
      const report = await runEvaluation({
        pack,
        runtime,
        judge,
        timeoutMs: job.configuration.timeoutMs,
        signal: controller.signal,
        onProgress: progress => {
          if (job.status === "cancelled" || controller.signal.aborted) return;
          if (progress.event) {
            const event = progress.event;
            const key = `${event.caseId}:${event.side}`;
            job.live ??= {};
            const live = job.live[key] ??= { caseId: event.caseId, side: event.side, output: "", status: "执行中", toolCalls: [] };
            if (event.type === "text_delta") live.output += event.text ?? "";
            if (event.type === "status") live.status = event.text ?? "执行中";
            if (event.type === "tool_start") live.toolCalls.push({ name: event.toolName ?? "tool", status: "running" });
            if (event.type === "tool_end") {
              const tool = [...live.toolCalls].reverse().find(item => item.name === event.toolName && item.status === "running");
              if (tool) tool.status = event.status ?? "completed";
            }
            job.status = "running";
            job.stageLabel = stageLabel("executing");
            if (event.type === "text_delta" && Date.now() - lastLivePublishedAt < 150) return;
            lastLivePublishedAt = Date.now();
            this.options.jobs.updateLive(job);
            this.emit(job);
            return;
          }
          job.status = progress.stage === "judging"
            ? "judging"
            : progress.stage === "completed" ? "running" : progress.stage === "preparing" ? "preparing" : "running";
          job.stageLabel = stageLabel(progress.stage);
          job.progress = {
            completedRuns: progress.completedRuns,
            totalRuns: progress.totalRuns,
            ...(progress.caseId ? { caseId: progress.caseId } : {}),
            ...(progress.side ? { side: progress.side } : {}),
          };
          if (progress.evidence) {
            const key = `${progress.evidence.caseId}:${progress.evidence.side}`;
            job.evidence = job.evidence.filter(item => item && `${item.caseId}:${item.side}` !== key);
            job.evidence.push(progress.evidence);
          }
          void this.options.jobs.save(job).then(saved => this.emit(saved));
        },
      });
      if (this.options.jobs.get(job.jobId)?.status === "cancelled") return;
      job.status = "completed";
      job.stageLabel = "评测完成";
      job.report = report;
      if (job.questionSet) {
        report.questionSet = job.questionSet;
        const { reportFingerprint: _previous, ...content } = report;
        report.reportFingerprint = fingerprint(content);
      }
      job.completedAt = new Date().toISOString();
      await this.options.jobs.save(job);
      this.emit(job);
    } catch (error) {
      if (job.status === "cancelled" || error instanceof EvaluationCancelledError || controller.signal.aborted) {
        if (job.status !== "cancelled") await this.cancel(job.jobId);
        return;
      }
      job.status = "failed";
      job.stageLabel = "评测失败";
      job.error = {
        code: errorCode(error),
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
      job.completedAt = new Date().toISOString();
      await this.options.jobs.save(job);
      this.emit(job);
    }
  }
}
