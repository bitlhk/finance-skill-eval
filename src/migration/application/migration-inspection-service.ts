import { z } from "zod";
import type { MigrationAnalyzer } from "./migration-agent-port.js";
import { toProjectInspection } from "../infrastructure/migration-agent.js";
import {
  analyzeDependencies,
} from "../infrastructure/migration-dependencies.js";
import {validateDependencyData} from '../domain/migration-dependency-schema.js';
import type { Supplement } from "../domain/migration-dependency.js";
import { runtimeBuildRequirements } from "../domain/migration-harness.js";
import { runtimeBuildRequirementsYaml } from "../infrastructure/migration-harness-serializer.js";
import {
  buildMigrationPlan,
  recommendLanguage,
  stableToolId,
  supportsImplicitScriptContext,
  type ProjectInspection,
  type ToolDecision,
} from "../domain/migration-model.js";
import {migrationExecutionConfig,runtimeInjection,serviceEnvironment} from '../domain/migration-runtime-rules.js';
import { configurationDigest } from '../domain/migration-runtime-configuration.js';
import type { MigrationSkillRepository } from "./migration-skill-repository.js";
import { validateSkill } from "../domain/migration-skill-validator.js";
import { stageEnvelope, staleAgainst } from "../domain/migration-stage-envelope.js";
import type { MigrationProjectStore } from "./migration-project-store.js";
import { migrationConflict as conflict } from "./migration-errors.js";
import type { MigrationRuntimeConfigurationRepository } from './migration-runtime-configuration-repository.js';
import type { MigrationSupplementRepository } from './migration-supplement-repository.js';
import type { MigrationBusinessConnectionProbe } from './migration-business-connection-probe.js';

export type MigrationRuntimeReference = {
  migrationId: string;
  revision: number;
  assetDigest: string;
  configurationDigest: string;
};

export class MigrationInspectionService {
  constructor(
    private readonly projects: MigrationProjectStore,
    private readonly skills: MigrationSkillRepository,
    private readonly analyzer: MigrationAnalyzer,
    private readonly runtimeConfigs:MigrationRuntimeConfigurationRepository,
    private readonly supplements:MigrationSupplementRepository,
    private readonly connectionProbe:MigrationBusinessConnectionProbe,
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
          const candidate = toProjectInspection(agent.payload as never, asset.assetId, asset.artifactSha256, stableToolId, agent.scanner ?? null, files);
          if (candidate.tools.length || candidate.runtimeCapabilities?.length || candidate.skill.status !== "UNKNOWN") inspection = candidate;
        } catch { inspection = null; }
      }
      if (!inspection) return conflict("分析不可用：A2 agent 未产出工具与基线。静态规则不再猜测工具与输入输出，因此无法继续迁移。");

      const byRules = validateSkill(originalFiles, asset.skillFile);
      const agentSkillFindings = inspection.skill.findings.filter(finding =>
        finding.code !== "DIRECTORY_NAME_MISMATCH"
        && !/(?:目录名|文件夹名).{0,20}(?:name|名称)|(?:name|名称).{0,20}(?:目录名|文件夹名)/iu.test(`${finding.message} ${finding.suggestion}`));
      inspection.skill = { status: byRules.status, findings: [...byRules.findings, ...agentSkillFindings] };
      inspection.dependencyAnalysis = analyzeDependencies(
        agent!.payload,
        inspection,
        files,
        supplementItems,
        record.revision,
        this.supplements.digest(record),
        agent?.status === "PRODUCED" || agent?.status === "ABSTAINED" ? agent.workspaceRoot : undefined,
        agent?.status === "PRODUCED" || agent?.status === "ABSTAINED" ? agent.libraryInventory : undefined,
      );
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

  async dependencyData(id: string, dependencyId: string) {
    const value = await this.projects.get(id);
    const dependency = value.sourceInspection?.dependencyAnalysis?.dependencies.find(item => item.id === dependencyId);
    if (!dependency || !["DATA", "CONFIG"].includes(dependency.kind)) return conflict("当前诊断中不存在此数据项");
    if (dependency.owner === "RUNTIME") {
      const config = await this.runtimeConfigs.get(id);
      return { provided: dependencyId in config.values, value: config.values[dependencyId] ?? null };
    }
    const item = (await this.supplements.get(id)).items.find(supplement => supplement.dependencyId === dependencyId);
    return { provided: !!item, value: item?.value ?? null };
  }

  async runtimeConfiguration(id: string) {
    const value = await this.projects.get(id);
    const config = await this.runtimeConfigs.get(id);
    const dependencies = value.sourceInspection?.dependencyAnalysis?.dependencies ?? [];
    return {
      revision: config.revision,
      dependencies: dependencies.filter(dependency => dependency.owner === "RUNTIME" && dependency.action === "INJECT").map(dependency => {
        const implicit = supportsImplicitScriptContext(dependency);
        return {
          dependencyId: dependency.id,
          provided: implicit || dependency.id in config.values,
          valid: implicit || dependency.id in config.values && !validateDependencyData(config.values[dependency.id], dependency.schema).length,
          implicit,
        };
      }),
      checks: config.checks.map(check => ({
        ...check,
        current: check.configurationDigest === configurationDigest(config, dependencies)
          && check.assetDigest === (check.kind === "GENERATED_TOOL" ? value.candidate ?? value.source : value.source).artifactSha256,
      })),
    };
  }

  async saveRuntimeDependency(id: string, dependencyId: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const parsed = z.strictObject({ revision: z.number().int().nonnegative(), value: z.unknown() }).parse(input);
      if (!Object.prototype.hasOwnProperty.call(parsed, "value")) return conflict("请提供测试数据");
      const value = await this.projects.get(id);
      const dependency = value.sourceInspection?.dependencyAnalysis?.dependencies.find(item => item.id === dependencyId);
      if (!dependency || dependency.owner !== "RUNTIME" || dependency.action !== "INJECT") return conflict("当前诊断没有这项可注入的运行时依赖");
      const config = await this.runtimeConfigs.save(id, dependency, parsed.value, parsed.revision);
      return { revision: config.revision };
    });
  }

  async resolveRuntimeDependencies(reference: MigrationRuntimeReference) {
    const value = await this.projects.get(reference.migrationId);
    const config = await this.runtimeConfigs.get(reference.migrationId);
    const dependencies = value.sourceInspection?.dependencyAnalysis?.dependencies ?? [];
    if (!value.candidate || value.candidate.artifactSha256 !== reference.assetDigest || config.revision !== reference.revision
      || configurationDigest(config, dependencies) !== reference.configurationDigest) {
      return conflict("测试运行依赖或候选已变化，请重新配置验证");
    }
    return migrationExecutionConfig(dependencies, config.values, value.inspection?.tools ?? []);
  }

  async resolveServiceEnvironment(reference: MigrationRuntimeReference, toolNames: string[]) {
    const value = await this.projects.get(reference.migrationId);
    const config = await this.runtimeConfigs.get(reference.migrationId);
    const dependencies = value.sourceInspection?.dependencyAnalysis?.dependencies ?? [];
    if (!value.candidate || value.candidate.artifactSha256 !== reference.assetDigest || config.revision !== reference.revision
      || configurationDigest(config, dependencies) !== reference.configurationDigest) {
      return conflict("服务配置或候选已变化，请重新验证");
    }
    const tools = value.inspection?.tools ?? [];
    if (toolNames.some(name => !tools.some(tool => tool.name === name))) return conflict("服务配置关联了未知工具");
    const toolIds = tools.filter(tool => toolNames.includes(tool.name)).map(tool => tool.toolId);
    const selected = dependencies.filter(dependency => dependency.toolIds.some(toolId => toolIds.includes(toolId)));
    const resolved = serviceEnvironment(selected, config.values);
    const secretNames = new Set(selected.filter(dependency => dependency.sensitive && dependency.binding?.kind === "SERVICE_ENV")
      .map(dependency => dependency.binding!.name));
    return {
      configuration: Object.fromEntries(Object.entries(resolved).filter(([name]) => !secretNames.has(name))),
      secrets: Object.fromEntries(Object.entries(resolved).filter(([name]) => secretNames.has(name))),
    };
  }

  async checkBusinessConnection(id: string, input: unknown, signal?: AbortSignal) {
    return this.projects.runExclusive(id, async () => {
      const parsed = z.strictObject({
        toolId: z.string(),
        endpoint: z.string().url(),
        method: z.enum(["GET", "HEAD"]),
        confirmReadOnly: z.literal(true),
        revision: z.number().int().nonnegative(),
      }).parse(input);
      const value = await this.projects.get(id);
      const inspection = value.sourceInspection;
      if (!inspection?.tools.some(tool => tool.toolId === parsed.toolId)) return conflict("请先完成源工具诊断");
      const config = await this.runtimeConfigs.get(id);
      if (config.revision !== parsed.revision) return conflict("测试配置已变化，请刷新");
      const dependencies = inspection.dependencyAnalysis?.dependencies.filter(dependency => dependency.toolIds.includes(parsed.toolId)) ?? [];
      const injection = runtimeInjection(dependencies, config.values, "HTTP_HEADER");
      if (injection.missing.length) return conflict(`请先提供测试依赖：${injection.missing.join("、")}`);
      const result = await this.connectionProbe.probe(parsed.endpoint, parsed.method, injection.headers, signal);
      return this.runtimeConfigs.check(id, {
        ...result,
        toolId: parsed.toolId,
        kind: "BUSINESS_INTERFACE",
        configurationDigest: configurationDigest(config, inspection.dependencyAnalysis?.dependencies),
        assetDigest: value.source.artifactSha256,
      });
    });
  }

  async supplementDependency(id: string, dependencyId: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const parsed = z.strictObject({ revision: z.number().int().nonnegative(), value: z.unknown() }).parse(input);
      if (!Object.prototype.hasOwnProperty.call(parsed, "value")) return conflict("请提供数据");
      return this.saveDependency(id, dependencyId, parsed.revision, { value: parsed.value });
    });
  }

  async uploadDependency(id: string, dependencyId: string, revision: number, filename: string, bytes: Buffer) {
    return this.projects.runExclusive(id, () =>
      this.saveDependency(id, dependencyId, revision, { files: this.supplements.unpack(dependencyId, filename, bytes), filename }));
  }

  async explainDependency(id: string, dependencyId: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const parsed = z.strictObject({ revision: z.number().int().nonnegative(), explanation: z.string().trim().min(1).max(16000) }).parse(input);
      const previous = (await this.supplements.get(id)).items.find(item => item.dependencyId === dependencyId);
      const supplementPath = `.diagnosis-supplements/${dependencyId}/dependency-contract.md`;
      return this.saveDependency(id, dependencyId, parsed.revision, {
        files: { ...previous?.files, [supplementPath]: Buffer.from(parsed.explanation, "utf8").toString("base64") },
        filename: previous?.filename ?? "dependency-contract.md",
      }, true);
    });
  }

  private async saveDependency(id: string, dependencyId: string, revision: number, content: Partial<Supplement>, explanation = false) {
    const value = await this.projects.get(id);
    const diagnostic = value.sourceInspection?.dependencyAnalysis;
    const dependency = diagnostic?.dependencies.find(item => item.id === dependencyId);
    if (!dependency) return conflict("缺项已变化，请刷新诊断");
    if (dependency.owner !== "TOOL" && !explanation) return conflict("运行时依赖请在运行配置中提供；归属未确认的依赖请补充契约说明");
    const record = await this.supplements.get(id);
    if (!Number.isInteger(revision) || revision !== record.revision) return conflict("补充内容已变化，请刷新后再提交");
    if (content.files && !["SDK", "RESOURCE", "CONFIG"].includes(dependency.kind) && !explanation) return conflict("此依赖需要直接填写数据");
    if ("value" in content && !["DATA", "CONFIG"].includes(dependency.kind)) return conflict("此依赖需要上传文件");
    if ("value" in content) {
      const errors = validateDependencyData(content.value, dependency.schema);
      if (errors.length) throw Object.assign(new Error(errors.join("；")), { statusCode: 400 });
      if (Buffer.byteLength(JSON.stringify(content.value)) > 128000) throw Object.assign(new Error("补充数据超过 128 KB"), { statusCode: 400 });
    }
    const saved = await this.supplements.save(id, { dependencyId, kind: dependency.kind, ...content, updatedAt: new Date().toISOString() });
    diagnostic!.revision = saved.revision;
    diagnostic!.materialsDigest = this.supplements.digest(saved);
    diagnostic!.status = "PARTIAL";
    dependency.provided = "PENDING";
    dependency.issue = "已提供，等待继续分析";
    value.candidate = null;
    value.inspection = structuredClone(value.sourceInspection!);
    value.analysis = undefined;
    await this.projects.save(value);
    return { revision: saved.revision, inspection: value.inspection };
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
    const yaml = runtimeBuildRequirementsYaml(inspection);
    if (!yaml) return conflict("当前迁移没有 Runtime Harness 改造需求");
    return yaml;
  }
}
