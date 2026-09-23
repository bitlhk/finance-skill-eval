import { z } from "zod";
import type { MigrationAnalyzer } from "./migration-agent-port.js";
import { runtimeBuildRequirements } from "../domain/migration-harness.js";
import {
  buildMigrationPlan,
  recommendLanguage,
  supportsImplicitScriptContext,
  type ProjectInspection,
  type ToolDecision,
} from "../domain/migration-model.js";
import type { MigrationSkillRepository } from "./migration-skill-repository.js";
import { validateSkill } from "../domain/migration-skill-validator.js";
import { stageEnvelope, staleAgainst } from "../domain/migration-stage-envelope.js";
import type { MigrationProjectStore } from "./migration-project-store.js";
import { migrationConflict as conflict } from "./migration-errors.js";
import type { MigrationSupplementRepository } from './migration-supplement-repository.js';
import type { MigrationHarnessSerializer } from './migration-harness-serializer.js';
import type { MigrationDependencyAnalyzer } from './migration-dependency-analyzer.js';
import type { MigrationAgentResultMapper } from './migration-agent-result-mapper.js';

export class MigrationInspectionService {
  constructor(
    private readonly projects: MigrationProjectStore,
    private readonly skills: MigrationSkillRepository,
    private readonly analyzer: MigrationAnalyzer,
    private readonly supplements:MigrationSupplementRepository,
    private readonly harnessSerializer:MigrationHarnessSerializer,
    private readonly dependencyAnalyzer:MigrationDependencyAnalyzer,
    private readonly agentResults:MigrationAgentResultMapper,
  ) {}

  async inspect(id: string, sourceOnly = false) {
    return this.projects.runExclusive(id, async () => {
      const value = await this.projects.get(id);
      const asset = sourceOnly ? value.source : value.candidate ?? value.source;
      const archive = await this.skills.readArchive(asset.assetId);
      const originalFiles: Record<string, string> = {};
      for (const [name, bytes] of Object.entries(archive)) {
        try { originalFiles[name] = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {}
      }

      const record = await this.supplements.get(id);
      const supplementItems = asset.assetId === value.source.assetId ? record.items : [];
      for (const item of supplementItems) {
        for (const [file, bytes] of Object.entries(item.files ?? {})) archive[file] = Buffer.from(bytes, "base64");
      }
      const files: Record<string, string> = {};
      for (const [name, bytes] of Object.entries(archive)) {
        try { files[name] = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {}
      }

      const currentDependencies = value.sourceInspection?.dependencyAnalysis?.dependencies ?? [];
      const agent = await this.analyzer({
        assetDigest: asset.artifactSha256,
        runId: id,
        files: archive,
        supplements: supplementItems.map(item => ({
          dependencyId: item.dependencyId,
          key: currentDependencies.find(dependency => dependency.id === item.dependencyId)?.key ?? item.dependencyId,
          kind: item.kind,
          provided: true,
          paths: Object.keys(item.files ?? {}),
        })),
      }).catch(() => null);

      if (agent?.status === "ABSTAINED" && !agent.payload) {
        return conflict(`分析 agent 判定这个工程无法完成分析：${agent.reason}${agent.missing.length ? `（缺 ${agent.missing.join("、")}）` : ""}。请补齐后重新检查。`);
      }
      if (agent?.status === "FAILED") {
        return conflict(`分析 agent 没有跑完：${agent.reason}。这是执行问题不是工程问题，请重试或查看 agent 日志。`);
      }

      let inspection: ProjectInspection | null = null;
      if (agent?.status === "PRODUCED" || agent?.status === "ABSTAINED") {
        try {
          const candidate = this.agentResults.inspection({payload:agent.payload,assetId:asset.assetId,assetDigest:asset.artifactSha256,scanner:agent.scanner ?? null,files});
          if (candidate.tools.length || candidate.runtimeCapabilities?.length || candidate.skill.status !== "UNKNOWN") inspection = candidate;
        } catch { inspection = null; }
      }
      if (!inspection) return conflict("分析不可用：A2 agent 未产出工具与基线。静态规则不再猜测工具与输入输出，因此无法继续迁移。");

      const byRules = validateSkill(originalFiles, asset.skillFile);
      const agentSkillFindings = inspection.skill.findings.filter(finding =>
        finding.code !== "DIRECTORY_NAME_MISMATCH"
        && !/(?:目录名|文件夹名).{0,20}(?:name|名称)|(?:name|名称).{0,20}(?:目录名|文件夹名)/iu.test(`${finding.message} ${finding.suggestion}`));
      inspection.skill = { status: byRules.status, findings: [...byRules.findings, ...agentSkillFindings] };
      inspection.dependencyAnalysis = this.dependencyAnalyzer.analyze({
        payload:agent!.payload,
        inspection,
        files,
        supplements:supplementItems,
        revision:record.revision,
        materialsDigest:this.supplements.digest(record),
        workspaceRoot:agent?.status === "PRODUCED" || agent?.status === "ABSTAINED" ? agent.workspaceRoot : undefined,
        libraryInventory:agent?.status === "PRODUCED" || agent?.status === "ABSTAINED" ? agent.libraryInventory : undefined,
      });
      if (agent?.status === "ABSTAINED") {
        inspection.dependencyAnalysis.status = "PARTIAL";
        inspection.dependencyAnalysis.reason = agent.reason;
      }
      for (const tool of inspection.tools) {
        if (inspection.dependencyAnalysis.dependencies.some(dependency =>
          dependency.toolIds.includes(tool.toolId) && dependency.owner === "RUNTIME" && dependency.action === "INJECT" && !supportsImplicitScriptContext(dependency))) {
          tool.recommendedForm = "MCP";
          tool.recommendedLanguage = recommendLanguage("MCP", tool.language);
          tool.recommendationReason = "此实现需要 Runtime 上下文或凭证注入，应迁移为 MCP 服务；Script command 不支持额外注入。";
        } else if (inspection.dependencyAnalysis.dependencies.some(dependency =>
          dependency.toolIds.includes(tool.toolId) && supportsImplicitScriptContext(dependency))) {
          tool.recommendedForm = "SCRIPT";
          tool.recommendedLanguage = recommendLanguage("SCRIPT", tool.language);
          tool.recommendationReason = "仅依赖 Runtime 已提供的 workspace cwd，可作为独立脚本执行，不需要额外上下文注入。";
        }
      }

      if (asset.assetId === value.source.assetId) value.sourceInspection = structuredClone(inspection);
      if (sourceOnly && value.candidate) {
        await this.projects.save(value);
        return inspection;
      }
      value.inspection = inspection;
      value.analysis = stageEnvelope({
        assetDigest: asset.artifactSha256,
        stageId: "A2",
        producer: "AGENT",
        status: agent?.status === "ABSTAINED" ? "ABSTAINED" : "PRODUCED",
        inputDigests: { supplements: this.supplements.digest(record) },
        payload: inspection,
      });
      value.decisions = (value.decisions ?? []).filter(decision =>
        decision.baseAssetId === asset.assetId && value.inspection!.tools.some(tool => tool.toolId === decision.toolId));
      await this.projects.save(value);
      return value.inspection;
    });
  }

  async inspection(id: string) {
    const value = await this.projects.get(id);
    const asset = value.candidate ?? value.source;
    if (!value.inspection || value.inspection.assetId !== asset.assetId) return this.inspect(id);
    if (value.analysis && staleAgainst(value.analysis, { asset: asset.artifactSha256 })) return this.inspect(id);
    return value.inspection;
  }

  async decide(id: string, toolId: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const parsed = z.strictObject({
        form: z.enum(["MCP", "SCRIPT"]),
        language: z.string().min(1).max(40).optional(),
        reason: z.string().min(1).max(1000).optional(),
        baseAssetId: z.string().min(1),
      }).parse(input);
      const value = await this.projects.get(id);
      const asset = value.candidate ?? value.source;
      if (parsed.baseAssetId !== asset.assetId) return conflict("资产已变化，请刷新检查结果后重新确认");
      if (!value.inspection || value.inspection.assetId !== asset.assetId) return conflict("请先检查当前资产");
      const tool = value.inspection.tools.find(item => item.toolId === toolId);
      if (!tool) return conflict("当前检查结果中不存在这个 Tool");
      const decision: ToolDecision = {
        toolId,
        form: parsed.form,
        language: parsed.language ?? recommendLanguage(parsed.form, tool.language),
        reason: parsed.reason ?? (parsed.form === "MCP" ? "迁移到本 Skill 的共享 MCP 服务" : "迁移为独立脚本 Tool"),
        baseAssetId: parsed.baseAssetId,
        decidedAt: new Date().toISOString(),
      };
      value.decisions = [...(value.decisions ?? []).filter(item => !(item.toolId === toolId && item.baseAssetId === parsed.baseAssetId)), decision];
      await this.projects.save(value);
      return decision;
    });
  }

  async plan(id: string) {
    const value = await this.projects.get(id);
    const asset = value.candidate ?? value.source;
    if (!value.inspection || value.inspection.assetId !== asset.assetId) return conflict("请先检查当前资产");
    return buildMigrationPlan(value.inspection, value.decisions ?? [], asset.assetId);
  }

  async runtimeRequirements(id: string) {
    const value = await this.projects.get(id);
    const inspection = value.sourceInspection ?? value.inspection;
    if (!inspection) return conflict("请先完成源码诊断");
    return runtimeBuildRequirements(inspection)
      ?? { schemaVersion: "finance.runtime-build-requirements.v1", status: "NOT_REQUIRED", requiredCapabilities: [] };
  }

  async runtimeRequirementsYaml(id: string) {
    const value = await this.projects.get(id);
    const inspection = value.sourceInspection ?? value.inspection;
    if (!inspection) return conflict("请先完成源码诊断");
    const yaml = this.harnessSerializer.serialize(inspection);
    if (!yaml) return conflict("当前迁移没有 Runtime Harness 改造需求");
    return yaml;
  }
}
