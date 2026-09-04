import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { RuntimeAdapter } from "../adapters.js";
import type { EvalPack } from "../contracts.js";
import { DirectModelRuntimeAdapter } from "../direct-model-runtime.js";
import { HttpRuntimeAdapter, type RuntimeEnvironmentDescriptor } from "../http-runtime.js";
import { DeterministicRubricJudge, ModelPairwiseJudge, type PairwiseJudge } from "../judge.js";
import { ReplayRuntimeAdapter } from "../replay.js";
import { EvaluationCancelledError, runEvaluation } from "../runner.js";
import { configuredModelRole } from "./config.js";
import { runConfigurationSchema, type EnvironmentRecord, type RunConfiguration } from "./contracts.js";
import type { EvalPackCatalog } from "./catalog.js";
import type { EnvironmentStore } from "./environment-store.js";
import { EvaluationJobStore, type EvaluationJob } from "./job-store.js";
import type { PreparationStore } from "./preparation-store.js";
import type { SkillStore } from "./skill-store.js";

type RunManagerOptions = {
  catalog: EvalPackCatalog;
  preparations: PreparationStore;
  skills: SkillStore;
  environments: EnvironmentStore;
  jobs: EvaluationJobStore;
  maxConcurrentRuns: number;
};

function stageLabel(stage: string): string {
  if (stage === "preparing") return "环境预检与候选准备";
  if (stage === "executing") return "左右候选同步执行";
  if (stage === "judging") return "匿名专业 Judge 评阅";
  return "评测完成";
}

function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
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

  async create(input: unknown): Promise<EvaluationJob> {
    const configuration = runConfigurationSchema.parse(input);
    const now = new Date().toISOString();
    const job: EvaluationJob = {
      schemaVersion: "finance.skill-eval.job.v1",
      jobId: `run-${randomUUID()}`,
      status: "queued",
      stageLabel: "等待执行资源",
      configuration,
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
      throw new Error("Only failed, cancelled or interrupted runs can be retried");
    }
    return this.create(existing.configuration);
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
    if (!pack) throw new Error("Evaluation Pack is unavailable");
    const selected = configuration.selectedCaseIds.length
      ? pack.cases.filter(evalCase => configuration.selectedCaseIds.includes(evalCase.caseId))
      : pack.cases;
    if (selected.length === 0) throw new Error("No evaluation cases were selected");
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
        execution: executionModel
          ? { left: executionModel, right: executionModel }
          : pack.models.execution,
        judge: configuration.judgeModel ?? pack.models.judge,
      },
    };
  }

  private async skillResolver(assetId: string | undefined) {
    if (!assetId) return async () => null;
    const asset = await this.options.skills.get(assetId);
    if (!asset) throw new Error(`Unknown Skill asset: ${assetId}`);
    const instructions = await this.options.skills.readSource(assetId);
    return async (variant: EvalPack["variants"]["left"]) => variant.mode === "skill_version"
      ? {
        skillId: asset.skillId,
        version: asset.version,
        artifactSha256: asset.artifactSha256,
        instructions,
      }
      : null;
  }

  private async runtimeFor(configuration: RunConfiguration, pack: EvalPack): Promise<RuntimeAdapter> {
    if (configuration.runtime.type === "replay") {
      if (!pack.cases.every(evalCase => Boolean(evalCase.replay))) {
        throw new Error("Selected cases do not provide frozen replay evidence");
      }
      return new ReplayRuntimeAdapter(pack);
    }
    const resolveSkill = await this.skillResolver(configuration.skillAssetId);
    if (configuration.runtime.type === "direct_model") {
      const execution = configuredModelRole("EXECUTION");
      if (!execution.adapter) throw new Error("Execution model is not configured on this service");
      if (!configuration.skillAssetId) {
        throw new Error("Direct model runtime requires an uploaded Skill asset");
      }
      if (pack.cases.some(evalCase => evalCase.requiredTools.length > 0)) {
        throw new Error("This test requires tools; select an Agent Runtime HTTP environment");
      }
      return new DirectModelRuntimeAdapter({ modelAdapter: execution.adapter, resolveSkill });
    }
    const environment = await this.options.environments.get(configuration.runtime.environmentId);
    if (!environment || environment.type !== "runtime_http") {
      throw new Error("Selected Agent Runtime HTTP environment is unavailable");
    }
    const descriptor = await this.environmentDescriptor(environment);
    return new HttpRuntimeAdapter({
      adapterId: `http-runtime:${environment.environmentId}`,
      endpoint: environment.endpoint,
      headers: this.options.environments.headers(environment),
      environment: descriptor,
      resolveSkill: configuration.skillAssetId ? resolveSkill : undefined,
      timeoutMs: configuration.timeoutMs,
    });
  }

  private async environmentDescriptor(
    runtimeEnvironment: EnvironmentRecord,
  ): Promise<RuntimeEnvironmentDescriptor> {
    const mcpServers = [];
    for (const environmentId of runtimeEnvironment.mcpEnvironmentIds) {
      const environment = await this.options.environments.get(environmentId);
      if (!environment || environment.type !== "mcp_streamable_http") {
        throw new Error(`MCP environment is unavailable: ${environmentId}`);
      }
      const preflight = await this.options.environments.preflight(environment);
      if (preflight.status !== "ready" || !("tools" in preflight)) {
        throw new Error(`MCP preflight failed for ${environment.name}: ${preflight.error ?? "unknown"}`);
      }
      mcpServers.push({
        serverId: environment.environmentId,
        endpoint: environment.endpoint,
        transport: "streamable_http" as const,
        toolNames: preflight.tools.map(tool => tool.name),
      });
    }
    return { environmentId: runtimeEnvironment.environmentId, mcpServers };
  }

  private judgeFor(configuration: RunConfiguration, pack: EvalPack): PairwiseJudge {
    if (configuration.judgeMode === "deterministic") return new DeterministicRubricJudge();
    const judge = configuredModelRole("JUDGE");
    if (!judge.adapter) throw new Error("Judge model is not configured on this service");
    return new ModelPairwiseJudge(judge.adapter, configuration.judgeModel ?? pack.models.judge);
  }

  private async execute(job: EvaluationJob, controller: AbortController): Promise<void> {
    try {
      job.status = "preparing";
      job.stageLabel = stageLabel("preparing");
      job.startedAt = new Date().toISOString();
      await this.options.jobs.save(job);
      this.emit(job);
      const pack = await this.resolvePack(job.configuration);
      job.pack = {
        packId: pack.packId,
        version: pack.version,
        targetSkillId: pack.targetSkillId,
        targetSkillVersion: pack.targetSkillVersion,
        caseCount: pack.cases.length,
      };
      job.progress.totalRuns = pack.cases.length * 2;
      await this.options.jobs.save(job);
      const runtime = await this.runtimeFor(job.configuration, pack);
      const judge = this.judgeFor(job.configuration, pack);
      const report = await runEvaluation({
        pack,
        runtime,
        judge,
        timeoutMs: job.configuration.timeoutMs,
        signal: controller.signal,
        onProgress: progress => {
          if (job.status === "cancelled") return;
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
