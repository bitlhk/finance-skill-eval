import { z } from "zod";
import { manualPreparationSchema } from "../../service/contracts.js";
import type { MigrationAnalyzer } from "../../service/migration-agent.js";
import { toProjectInspection } from "../../service/migration-agent.js";
import { stableToolId } from "../../service/migration-model.js";
import { baselineBrief, type MigrationSuiteGenerator } from "../../service/migration-suite.js";
import type { PreparationStore } from "../../service/preparation-store.js";
import {
  normalizeOriginalServiceSuite,
  simpleMigrationCases,
  simpleMigrationSuiteSchema,
} from "../../service/simple-migration-suite.js";
import type { SkillAssetRecord, SkillStore } from "../../service/skill-store.js";
import { validateSkill } from "../../service/skill-validator.js";
import type { MigrationProjectRepository } from "../infrastructure/migration-project-repository.js";
import { migrationConflict as conflict } from "./migration-errors.js";

export class MigrationSuiteService {
  constructor(
    private readonly projects: MigrationProjectRepository,
    private readonly skills: SkillStore,
    private readonly analyzer: MigrationAnalyzer,
    private readonly suiteGenerator: MigrationSuiteGenerator,
    private readonly preparations?: PreparationStore,
  ) {}

  async create(id: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const parsed = manualPreparationSchema.parse(input);
      const project = await this.projects.get(id);
      if (!this.preparations) return conflict("题集服务不可用");
      const suite = await this.preparations.create({
        skill: project.source,
        summary: parsed.summary,
        cases: parsed.cases,
        holdoutCases: parsed.holdoutCases,
        source: "manual",
      });
      (project.suiteIds ??= []).push(suite.preparationId);
      await this.projects.save(project);
      return suite;
    });
  }

  async importSimple(id: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const originalServiceMode = !!input && typeof input === "object" && (input as { mode?: unknown }).mode === "service_comparison";
      const parsed = originalServiceMode ? normalizeOriginalServiceSuite(input) : simpleMigrationSuiteSchema.parse(input);
      const project = await this.projects.get(id);
      const comparisonOnly = originalServiceMode
        && (input as { cases: Array<{ criteria?: unknown }> }).cases.some(testCase => testCase.criteria === undefined);
      if (!this.preparations) return conflict("测试集服务不可用");
      const suite = await this.preparations.create({
        skill: project.source,
        summary: parsed.name,
        cases: simpleMigrationCases(parsed),
        source: "manual",
        assessmentMode: "natural_language",
        ...(comparisonOnly ? { comparisonOnly: true } : {}),
      });
      (project.suiteIds ??= []).push(suite.preparationId);
      await this.projects.save(project);
      return suite;
    });
  }

  /** Generate only from the frozen source analysis, never from generated candidate behavior. */
  async generate(id: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const parsed = z.strictObject({
        baseAssetId: z.string().min(1),
        maximumCases: z.number().int().min(1).max(8).optional(),
        assessmentMode: z.literal("natural_language").optional(),
      }).parse(input);
      const project = await this.projects.get(id);
      const current = project.candidate ?? project.source;
      const source = project.source;
      if (parsed.baseAssetId !== current.assetId) return conflict("资产已变化，请刷新后重新生成测试集");
      if (!project.inspection || project.inspection.assetId !== current.assetId) return conflict("测试集要从分析结果生成，请先检查当前资产");
      if (!this.preparations) return conflict("题集服务不可用");

      const skillSource = await this.decodedSkillSource(source);
      let sourceInspection = project.sourceInspection
        ?? (project.inspection.assetId === source.assetId ? project.inspection : null);
      if (!sourceInspection) {
        const archive = await this.skills.readArchive(source.assetId);
        const files: Record<string, string> = {};
        for (const [name, bytes] of Object.entries(archive)) {
          try { files[name] = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {}
        }
        const result = await this.analyzer({ assetDigest: source.artifactSha256, runId: `${id}-source`, files: archive });
        if (!result || result.status !== "PRODUCED") return conflict("原始资产分析未完成，不能使用候选分析替代出题依据");
        sourceInspection = toProjectInspection(
          result.payload as never,
          source.assetId,
          source.artifactSha256,
          stableToolId,
          result.scanner ?? null,
          files,
        );
        sourceInspection.skill = validateSkill(files, source.skillFile);
        project.sourceInspection = structuredClone(sourceInspection);
      }
      if (sourceInspection.assetDigest !== source.artifactSha256) return conflict("缺少原始资产的冻结分析，请重新分析原始资产后生成测试集");

      const generated = await this.suiteGenerator({
        skillId: source.skillId,
        skillSource: `${skillSource}\n\n${baselineBrief(sourceInspection)}`,
        tools: sourceInspection.tools.map(tool => tool.name),
        documentedInputs: sourceInspection.tools.flatMap(tool =>
          tool.samples.slice(0, 2).map(sample => ({ toolName: tool.name, input: sample.input }))),
        ...(parsed.maximumCases === undefined ? {} : { maximumCases: parsed.maximumCases }),
        generationId: `migration-suite-${id}`,
      });
      const cases = parsed.assessmentMode === "natural_language"
        ? generated.cases.map(testCase => ({
          ...testCase,
          rubric: testCase.rubric.map(criterion => ({ ...criterion, allOf: [], anyOf: [], noneOf: [] })),
        }))
        : generated.cases;
      const suite = await this.preparations.create({
        skill: source,
        summary: generated.summary,
        cases,
        source: "ai_generated",
        ...(parsed.assessmentMode ? { assessmentMode: parsed.assessmentMode } : {}),
      });
      (project.suiteIds ??= []).push(suite.preparationId);
      await this.projects.save(project);
      return suite;
    });
  }

  private async decodedSkillSource(asset: SkillAssetRecord): Promise<string> {
    const archive = await this.skills.readArchive(asset.assetId);
    const decode = (name: string) => {
      const bytes = archive[name];
      if (!bytes) return "";
      try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return ""; }
    };
    let remaining = 24_000;
    const parts = [`# SKILL.md\n${decode(asset.skillFile).slice(0, remaining)}`];
    remaining -= Math.min(remaining, parts[0]!.length);
    for (const name of Object.keys(archive).sort()) {
      if (remaining <= 0) break;
      const skillRoot = asset.skillFile.includes("/") ? asset.skillFile.slice(0, asset.skillFile.lastIndexOf("/") + 1) : "";
      if (!(name.startsWith(`${skillRoot}references/`) && /\.md$/u.test(name)) || /evals?\/|holdout|sealed|labels/iu.test(name)) continue;
      const text = decode(name).slice(0, Math.min(remaining, 8_000));
      parts.push(`# ${name}\n${text}`);
      remaining -= text.length;
    }
    return parts.join("\n\n");
  }
}
