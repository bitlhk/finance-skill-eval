import { randomUUID } from "node:crypto";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { configuredModelRole } from "./config.js";
import { ensureDirectory, listJsonFiles, readJson, writeJsonAtomic } from "./file-store.js";
import type { EvaluationJobStore } from "./job-store.js";
import type { EvaluationRunManager } from "./run-manager.js";
import type { SkillStore, SkillAssetRecord } from "./skill-store.js";
import type { EvalPackCatalog } from "./catalog.js";
import { fingerprint } from '../contracts.js';
import type { RunConfiguration } from './contracts.js';
import type { PreparationStore } from './preparation-store.js';
import type { Optimization } from '../shared/contracts/optimization.js';
export type { Optimization } from '../shared/contracts/optimization.js';

const proposalSchema = z.strictObject({
  summary: z.string().min(1).max(4000),
  findings: z.array(z.string().max(1500)).min(1).max(8),
  changes: z.array(z.strictObject({ path: z.string(), content: z.string().min(1).max(80000), reason: z.string().max(2000) })).min(1).max(6),
});
export function optimizationRerunBindings(configuration:RunConfiguration, original:SkillAssetRecord, candidate:SkillAssetRecord) {
  if (!configuration.runtimeBindings) return {};
  const environmentId=configuration.runtimeBindings.right.environmentId;
  const runtime={type:'runtime_launcher' as const,environmentId};
  return {runtime,runtimeBindings:{
    left:{environmentId,skillAssetId:original.assetId},right:{environmentId,skillAssetId:candidate.assetId}}};
}

export function candidateFiles(files: Record<string, string>, changes: Array<{ path: string; content: string }>, version: string): Record<string, string> {
  const next = { ...files };
  const seen = new Set<string>();
  for (const change of changes) {
    if (!(change.path === "SKILL.md" || /^references\/[a-zA-Z0-9_/-]+\.md$/u.test(change.path)) || change.path.includes("..") || seen.has(change.path)) {
      throw new Error("候选只能修改 SKILL.md 与 references 下的 Markdown");
    }
    seen.add(change.path); next[change.path] = change.content;
  }
  const match = next["SKILL.md"]?.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/u);
  if (!match) throw new Error("候选需要合法的 Skill frontmatter");
  const original = files["SKILL.md"]?.match(/^---\s*\n([\s\S]*?)\n---/u);
  const identity = original ? parse(original[1]!) : null;
  const metadata = parse(match[1]!);
  if (!identity?.name || metadata?.name !== identity.name) throw new Error("优化器不能改变 Skill 身份");
  next["SKILL.md"] = `---\n${stringify({ ...metadata, name: identity.name, version })}---\n\n${match[2]}`;
  if (Object.values(next).reduce((sum, text) => sum + Buffer.byteLength(text), 0) > 240000) throw new Error("候选包超出文本大小上限");
  return next;
}

export class OptimizationManager {
  private readonly directory: string;
  private readonly active = new Map<string, AbortController>();
  constructor(private readonly options: { dataDirectory: string; skills: SkillStore; jobs: EvaluationJobStore; runs: EvaluationRunManager; catalog: EvalPackCatalog; preparations?:PreparationStore }) {
    this.directory = path.join(options.dataDirectory, "optimizations");
  }
  private async suite(configuration:RunConfiguration) {
    if (configuration.packId) return this.options.catalog.get(configuration.packId);
    const preparation=configuration.preparationId ? await this.options.preparations?.get(configuration.preparationId):null;
    if (!preparation) return null;
    return this.options.preparations!.buildPack({preparation,analyzerModel:configuredModelRole('ANALYZER').model,
      executionModel:configuration.executionModel??configuredModelRole('EXECUTION').model,judgeModel:configuredModelRole('JUDGE').model});
  }
  async get(id: string): Promise<Optimization> {
    if (!/^opt-[a-f0-9-]+$/u.test(id)) throw new Error("优化记录 ID 不合法");
    // A live task can finish while readJson is reading an older atomic snapshot.
    const wasActive = this.active.has(id);
    const item = await readJson<Optimization>(path.join(this.directory, `${id}.json`));
    if (!wasActive && ["diagnosing", "validating", "reevaluating"].includes(item.status) && !this.active.has(id)) {
      item.status = "failed"; item.error = "Service restarted; candidate was not adopted"; await this.save(item);
    }
    return item;
  }
  async forSource(sourceJobId: string): Promise<Optimization | null> {
    const items: Optimization[] = [];
    for (const file of await listJsonFiles(this.directory)) {
      const item = await readJson<Optimization>(file);
      if (item.sourceJobId === sourceJobId) items.push(item);
    }
    const latest = items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
    return latest ? this.get(latest.optimizationId) : null;
  }
  private async save(item: Optimization) {
    item.updatedAt = new Date().toISOString();
    await ensureDirectory(this.directory);
    await writeJsonAtomic(path.join(this.directory, `${item.optimizationId}.json`), item);
  }
  private async stage(item: Optimization, status: Optimization["status"]) {
    item.status = status; item.stages.push({ stage: status, at: new Date().toISOString() }); await this.save(item);
  }
  async create(sourceJobId: string): Promise<Optimization> {
    if (this.active.size) throw new Error("已有一轮 Skill 优化正在进行");
    const source = this.options.jobs.get(sourceJobId);
    if (!source?.report || source.status !== "completed" || source.configuration.runtime.type!=='runtime_launcher') throw new Error("请先使用 Runtime Launcher 完成一轮在线评测");
    if (!source.report.cases.length) throw new Error('评测没有实际执行案例，不启动优化');
    if (source.report.cases.some(c => c.left.status !== "completed" || c.right.status !== "completed" || !c.judge)) throw new Error("运行或阅卷不完整，应修复环境后重测，不能据此修改 Skill");
    if (source.report.cases.some(c => [...c.left.toolCalls, ...c.right.toolCalls].some(t => t.status === "failed"))) throw new Error("存在工具失败，应先排查环境，不能将运行故障当作 Skill 缺陷");
    const variant = source.report.variants.right;
    if (variant.mode !== "skill_version") throw new Error("右侧必须为已装配 Skill");
    const assets = await this.options.skills.list();
    const binding=source.configuration.runtimeBindings;
    if (binding && binding.left.environmentId!==binding.right.environmentId) throw new Error('跨执行栈差异不能直接归因于 Skill；请先在同一 Runtime 完成候选评测再优化');
    const asset = assets.find(a => (!binding || a.assetId===binding.right.skillAssetId) && a.skillId === variant.skillId && a.version === variant.version && (!variant.artifactSha256 || a.artifactSha256 === variant.artifactSha256));
    if (!asset) throw new Error("原始 Skill 文件不可用");
    await this.options.skills.readArchive(asset.assetId);
    const models = source.report.models.execution;
    const modelFingerprint=(model:typeof models.left)=>fingerprint({providerId:model.providerId,modelId:model.modelId,parameters:model.parameters??{}});
    if (modelFingerprint(models.left)!==modelFingerprint(models.right)) throw new Error("请先用相同执行模型及参数评测，再判断 Skill 增益");
    const pack = await this.suite(source.configuration);
    if (!pack?.holdoutCases?.length) throw new Error("此试卷尚未配置冻结留出题，不启动候选复测");
    const optimizer = configuredModelRole("OPTIMIZER");
    if (!optimizer.adapter) throw new Error("优化模型未配置");
    const now = new Date().toISOString();
    const item: Optimization = { optimizationId: `opt-${randomUUID()}`, sourceJobId, sourceAssetId: asset.assetId, createdAt: now, updatedAt: now,
      status: "diagnosing", modelId: optimizer.model.modelId, summary: "", findings: [], changes: [], candidate: null, rerunJobId: null, error: null, stages: [{ stage: "diagnosing", at: now }] };
    const controller = new AbortController(); this.active.set(item.optimizationId, controller);
    await this.save(item);
    void this.run(item, controller).finally(() => this.active.delete(item.optimizationId));
    return item;
  }
  async reevaluate(id: string): Promise<Optimization> {
    if (this.active.size) throw new Error("已有一轮 Skill 优化正在进行");
    const item = await this.get(id);
    if (!["review", "failed"].includes(item.status) || !item.candidate) throw new Error("当前没有可重新复测的候选");
    if (item.rerunJobId) item.previousRerunJobIds = [...(item.previousRerunJobIds ?? []), item.rerunJobId];
    item.rerunJobId = null; item.error = null;
    const controller = new AbortController(); this.active.set(id, controller);
    await this.stage(item, "reevaluating");
    void this.evaluate(item, controller).catch(async error => {
      if (item.rerunJobId && controller.signal.aborted) await this.options.runs.cancel(item.rerunJobId);
      item.error = error instanceof Error ? error.message : String(error);
      await this.stage(item, controller.signal.aborted ? "cancelled" : "failed");
    }).finally(() => this.active.delete(id));
    return item;
  }
  private async run(item: Optimization, controller: AbortController) {
    try {
      const source = this.options.jobs.get(item.sourceJobId)!;
      const files = await this.options.skills.readFiles(item.sourceAssetId);
      const sourceAsset=(await this.options.skills.get(item.sourceAssetId))!;
      const archive=await this.options.skills.readArchive(item.sourceAssetId);
      const basename=path.posix.basename(sourceAsset.skillFile);
      if (basename!=='SKILL.md') {files['SKILL.md']=files[basename]!;delete files[basename];}
      const optimizer = configuredModelRole("OPTIMIZER");
      const developmentIds = new Set((source.questionSet?.cases ?? (await this.suite(source.configuration))!.cases).map(c => c.caseId));
      const completion = await optimizer.adapter!.complete({ requestId: item.optimizationId, model: optimizer.model, responseFormat: "json", signal: controller.signal,
        messages: [{ role: "system", content: "你是金融岗位 Skill 编辑专家，不是本轮 Judge。只针对真实业务质量缺口进行小范围修改，保留工具名称、权限边界和事实约束。不要添加题目答案、客户编号、固定产品比例、评分关键词或评测特例，不修复环境故障，不保证改进。返回JSON: {summary, findings: string[], changes:[{path,content,reason}]}。content是修改后的完整文件，最多修改3个文件，只允许SKILL.md或references/*.md。不得访问文件和工具。" },
          { role: "user", content: JSON.stringify({ files, developmentEvidence: source.report!.cases.filter(c => developmentIds.has(c.caseId)).map(c => ({ task: c.prompt, answer: c.right.output, review: c.judge?.summary, dimensions: c.judge?.dimensions })) }) }] });
      controller.signal.throwIfAborted();
      const proposal = proposalSchema.parse(JSON.parse(completion.content.replace(/^```(?:json)?\s*|\s*```$/gu, "")));
      item.summary = proposal.summary; item.findings = proposal.findings;
      await this.stage(item, "validating");
      const original = await this.options.skills.get(item.sourceAssetId);
      const version = `${original!.version}-candidate.${item.optimizationId.slice(4, 12)}`;
      const next = candidateFiles(files, proposal.changes, version);
      item.changes = proposal.changes.map(c => ({ path: c.path, before: files[c.path] ?? "", after: next[c.path]!, reason: c.reason }));
      const root=path.posix.dirname(sourceAsset.skillFile);
      for (const [name,content] of Object.entries(next)) {
        const actual=name==='SKILL.md'?sourceAsset.skillFile:path.posix.join(root,name);
        archive[actual]=strToU8(content);
      }
      item.candidate = await this.options.skills.uploadZip(Buffer.from(zipSync(archive)));
      controller.signal.throwIfAborted();
      await this.evaluate(item, controller);
    } catch (error) {
      if (item.rerunJobId && controller.signal.aborted) await this.options.runs.cancel(item.rerunJobId);
      item.error = error instanceof Error ? error.message : String(error);
      await this.stage(item, controller.signal.aborted ? "cancelled" : "failed");
    }
  }
  private async evaluate(item: Optimization, controller: AbortController) {
      const source = this.options.jobs.get(item.sourceJobId)!;
      const original = await this.options.skills.get(item.sourceAssetId);
      const developmentIds = new Set((source.questionSet?.cases ?? (await this.suite(source.configuration))!.cases).map(c => c.caseId));
      const variant = (a: SkillAssetRecord) => ({ mode: "skill_version", skillId: a.skillId, version: a.version, artifactSha256: a.artifactSha256 });
      const rerun = await this.options.runs.create({ ...source.configuration, caseSource: "fixed", selectedCaseIds: source.questionSet ? [] : source.report!.cases.filter(c => developmentIds.has(c.caseId)).map(c => c.caseId),
        ...optimizationRerunBindings(source.configuration,original!,item.candidate!),
        includeHoldout: true, leftVariant: variant(original!), rightVariant: variant(item.candidate!), skillAssetId: item.candidate!.assetId, judgeMode: "model",evaluationMode:"pairwise" }, source.questionSet);
      item.rerunJobId = rerun.jobId;
      await this.stage(item, "reevaluating");
      while (true) {
        controller.signal.throwIfAborted();
        const current = this.options.jobs.get(rerun.jobId)!;
        if (["failed", "cancelled", "interrupted"].includes(current.status)) throw new Error(current.error?.message ?? "Candidate evaluation did not complete");
        if (current.status === "completed") {
          if (!current.report?.cases.length || current.report.cases.some(c => !c.judge || c.left.status !== "completed" || c.right.status !== "completed"
              || [...c.left.toolCalls,...c.right.toolCalls].some(t=>t.status==='failed'))) throw new Error("候选复测存在未完成任务或工具失败，不能确认专业增益");
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      await this.stage(item, "review");
  }
  async decide(id: string, decision: "adopt" | "retain" | "cancel") {
    const item = await this.get(id);
    if (decision === "cancel") { this.active.get(id)?.abort(); return item; }
    if (item.status !== "review") throw new Error("候选尚未完成复测");
    await this.stage(item, decision === "adopt" ? "adopted" : "retained");
    // Adoption records a local decision only; originals and deployed Skills are immutable.
    return item;
  }
}
