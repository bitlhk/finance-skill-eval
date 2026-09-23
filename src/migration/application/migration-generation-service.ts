import { strToU8, zipSync } from "fflate";
import { z } from "zod";
import {
  contractSample,
  toGeneratedImplementations,
  toSkillDocumentDelivery,
} from "../infrastructure/migration-agent.js";
import type { MigrationImplementer } from "./migration-agent-port.js";
import type { MigrationCodeGeneratorPort } from "./migration-code-generator-port.js";
import { runtimeToolConfigTemplate, validateAgentRuntimeDelivery } from "../domain/migration-delivery-contract.js";
import type { MigrationDiagnosisPort } from "./migration-diagnosis-port.js";
import {
  buildMigrationPlan,
  languageOfSourcePaths,
  recommendLanguage,
  type MigrationPlan,
  type ProjectInspection,
  type ToolDecision,
} from "../domain/migration-model.js";
import { MigrationSupplements } from "../infrastructure/migration-supplements.js";
import { generatePortableCandidate } from "../infrastructure/migration-candidate-packager.js";
import type { PortableGeneration } from "../domain/migration-candidate-artifact.js";
import type { SkillAssetRecord } from "../../shared/contracts/skill-asset.js";
import type { MigrationSkillRepository } from "./migration-skill-repository.js";
import { inspectProject } from "../domain/migration-project-inspector.js";
import type { MigrationProjectStore } from "./migration-project-store.js";
import { migrationConflict as conflict } from "./migration-errors.js";

const CODE_FILE = /\.(?:java|py|js|mjs|cjs|ts)$/iu;
export class MigrationGenerationService {
  constructor(
    private readonly root: string,
    private readonly projects: MigrationProjectStore,
    private readonly skills: MigrationSkillRepository,
    private readonly implementer: MigrationImplementer,
    private readonly codeGenerator: MigrationCodeGeneratorPort,
    private readonly diagnostics?: MigrationDiagnosisPort,
  ) {}

  async generate(id: string, input: unknown) {
    return this.projects.runExclusive(id, async () => {
      const parsed = z.strictObject({
        baseAssetId: z.string().min(1),
        acknowledgePartialAnalysis: z.boolean().optional(),
      }).parse(input);
      const project = await this.projects.get(id);
      const currentAsset = project.candidate ?? project.source;
      if (parsed.baseAssetId !== currentAsset.assetId) return conflict("资产已变化，请刷新后重新生成");
      if (!project.inspection || project.inspection.assetId !== currentAsset.assetId) return conflict("请先检查当前资产");
      const generationInspection = project.sourceInspection ?? project.inspection;
      if (!generationInspection.staticAnalysis || generationInspection.staticAnalysis.status === "UNAVAILABLE") {
        return conflict("静态分析不可用，已阻止生成候选");
      }
      const toolPaths = new Set(generationInspection.tools.flatMap(tool => tool.sourcePaths));
      const incompleteFiles = generationInspection.staticAnalysis.toolIncompleteFiles
        ?? generationInspection.staticAnalysis.incompleteFiles.filter(item => toolPaths.has(item.path));
      if (incompleteFiles.length && !parsed.acknowledgePartialAnalysis) {
        return conflict(`静态分析未完整覆盖 Tool 相关源码；确认人工审阅后才能继续：${incompleteFiles.map(item => `${item.path} (${item.status})`).join("、")}`);
      }

      const plan = buildMigrationPlan(project.inspection, project.decisions ?? [], currentAsset.assetId);
      if (!plan.generationAllowed) return conflict("当前逐 Tool 决策尚不能生成候选");
      const archive = await this.skills.readArchive(project.source.assetId);
      const version = `2.0.0-migration.${(project.candidateHistory?.length ?? 0) + 1}`;
      for (const supplement of (await new MigrationSupplements(this.root).get(id)).items) {
        for (const [name, content] of Object.entries(supplement.files ?? {})) archive[name] = Buffer.from(content, "base64");
      }
      const decisions = project.decisions!.filter(decision => decision.baseAssetId === currentAsset.assetId);
      const delivery = await this.generateImplementations(archive, generationInspection, decisions, project.source, plan);
      const generated = generatePortableCandidate({
        archive,
        base: project.source,
        inspection: generationInspection,
        decisions,
        version,
        ...delivery,
      });
      if (generationInspection.dependencyAnalysis?.dependencies.length) {
        const dependencyPath = decisions.some(decision => decision.form === "MCP")
          ? "runtime-dependencies.json"
          : "scripts/runtime-dependencies.json";
        if (generated.files[dependencyPath]) return conflict("生成工程占用了运行依赖声明路径，请调整后重新生成");
        const declarations = generationInspection.tools.map(tool => ({
          tool: tool.name,
          dependencies: generationInspection.dependencyAnalysis!.dependencies
            .filter(dependency => dependency.toolIds.includes(tool.toolId) && dependency.owner === "RUNTIME" && dependency.action === "INJECT")
            .map(dependency => ({
              name: dependency.name,
              key: dependency.key,
              purpose: dependency.purpose,
              required: dependency.blocking,
              sensitive: dependency.sensitive,
              schema: dependency.schema,
              binding: dependency.binding,
            })),
        }));
        const content = `${JSON.stringify({ schemaVersion: "finance.tool-runtime-dependencies.v1", tools: declarations }, null, 2)}\n`;
        generated.files[dependencyPath] = strToU8(content);
        generated.diff.push({ path: dependencyPath, operation: "ADD", before: "", after: content });
      }

      const candidate = await this.skills.uploadZip(Buffer.from(zipSync(generated.files)), { version });
      const candidateInspection = await this.inspectCandidate({
        candidate,
        files: generated.files,
        inspection: generationInspection,
        decisions: project.decisions!,
        baseAssetId: currentAsset.assetId,
        generations: generated.generations,
      });
      const carriedDecisions = decisions.map(decision => ({
        ...decision,
        baseAssetId: candidate.assetId,
        decidedAt: new Date().toISOString(),
      }));
      project.decisions = [...(project.decisions ?? []), ...carriedDecisions];
      project.candidate = candidate;
      project.inspection = candidateInspection;
      project.candidateNotes = "按逐 Tool 决策生成符合 Skill 规范的完整候选；原始资产保持不变。";
      project.portableGenerations = generated.generations;
      project.portableGenerationDiff = generated.diff;
      (project.candidateHistory ??= []).push({
        asset: candidate,
        notes: project.candidateNotes,
        recordedAt: new Date().toISOString(),
        kind: "migration",
      });
      await this.projects.save(project);
      return project;
    });
  }

  private async generateImplementations(
    archive: Record<string, Uint8Array>,
    inspection: ProjectInspection,
    decisions: ToolDecision[],
    asset: SkillAssetRecord,
    plan: MigrationPlan,
  ) {
    const contract: Record<string, unknown> = {};
    for (const decision of decisions) {
      const tool = inspection.tools.find(item => item.toolId === decision.toolId);
      const language = plan.items.find(item => item.toolId === decision.toolId)?.language
        ?? recommendLanguage(decision.form, tool?.language ?? null);
      const sample = contractSample(tool);
      contract[decision.toolId] = {
        form: decision.form,
        language,
        toolName: tool?.name ?? "",
        dependencies: inspection.dependencyAnalysis?.dependencies.filter(dependency => dependency.toolIds.includes(decision.toolId)) ?? [],
        runtimeInjection: "SERVICE_ENV dependencies are startup configuration: read the declared environment variable inside the MCP service, never from request Headers or business arguments. Actual values are supplied by the launcher, never sent to this model. runtimeToolConfig is for MCP only: contextBindings map HTTP Header names to context references, auth providers return request headers, and business arguments remain separate. Script runs through generic command with no additional Runtime injection. Never ask the model to supply injected fields.",
        inputSchema: tool?.inputSchema ?? null,
        outputSchema: tool?.outputSchema ?? null,
        samples: (tool?.samples ?? []).map(item => item.input),
        ...( "reason" in sample ? { sampleMissing: sample.reason } : { sampleInput: sample.input }),
      };
    }

    const attempts = Math.max(1, Number(process.env.FINANCE_EVAL_AGENT_ATTEMPTS ?? 1));
    let agentFailure: string | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const result = await this.implementer({
        assetDigest: asset.artifactSha256,
        runId: asset.assetId,
        files: archive,
        decisions: decisions.map(decision => ({ toolId: decision.toolId, form: decision.form, language: decision.language })),
        tools: inspection.tools.map(tool => ({
          toolId: tool.toolId,
          name: tool.name,
          language: tool.language,
          sourcePaths: tool.sourcePaths,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema,
          samples: tool.samples,
          migrationContract: contract[tool.toolId],
        })),
        contract,
        deliveryContract: {
          skillDocumentation: { sourceSkillFile: asset.skillFile, manifestPathsRelativeToSkillRoot: true },
          script: { execution: "COMMAND", cwd: "WORKSPACE", entrypoint: "RUNTIME_PROVIDED_ABSOLUTE_PATH", packageResources: "RELATIVE_TO_SCRIPT", runtimeInjection: false },
          mcp: { contextTransport: "HTTP_HEADER", serviceConfigurationTransport: "SERVICE_ENV", businessArguments: "SEPARATE", pythonFramework: { package: "fastmcp", version: "2.14.7", import: "from fastmcp import FastMCP" } },
          runtimeToolConfigTemplate: runtimeToolConfigTemplate(inspection, decisions),
        },
      });
      if (result?.status === "PRODUCED" || result?.status === "ABSTAINED") {
        const abstained = ((result.payload as { tools?: Array<{ toolId?: string; status?: string; reason?: string; missing?: string[] }> }).tools ?? [])
          .filter(item => String(item.status ?? "").toUpperCase() === "ABSTAINED");
        if (abstained.length) {
          const detail = abstained.map(item => `${item.toolId || "未知 Tool"}：${item.reason?.trim() || "未说明原因"}${item.missing?.length ? `（缺 ${item.missing.join("、")}）` : ""}`).join("；");
          return conflict(`有 Tool 无法忠实迁移，已停止生成并退回授权环节重新决策。${detail}`);
        }
        if (result.status === "ABSTAINED") {
          return conflict(`迁移模型无法完成本次迁移，已退回授权环节重新决策。${String((result.payload as { reason?: string }).reason ?? "").trim()}`);
        }
      }
      if (result?.status === "FAILED") {
        agentFailure = result.reason;
        continue;
      }
      if (result?.status === "PRODUCED") {
        const deliveryIssues = validateAgentRuntimeDelivery(result.payload as Record<string, unknown>, inspection, decisions);
        if (deliveryIssues.length) {
          agentFailure = deliveryIssues.join("；");
          continue;
        }
        const nameById = Object.fromEntries(inspection.tools.map(tool => [tool.toolId, tool.name]));
        const implementations = toGeneratedImplementations(result.payload as never, result.files, nameById);
        const skillDelivery = toSkillDocumentDelivery(result.payload as never, result.files);
        const missing = decisions.filter(decision =>
          !implementations[decision.toolId]
          || implementations[decision.toolId]!.language !== plan.items.find(item => item.toolId === decision.toolId)?.language);
        if (!missing.length && skillDelivery) return { implementations, skillDelivery };
        if (!skillDelivery) {
          agentFailure = "A4 没有按文档清单交付最终 SKILL.md；平台不会在模型完成后替它机械合并或拆分 references";
          continue;
        }
        agentFailure = `A4 交付不完整或语言与授权不符：${missing.map(decision => nameById[decision.toolId] ?? decision.toolId).join("、")}`;
      }
    }
    if (agentFailure) {
      return conflict(`迁移 agent 跑完了但没交付可用结果：${agentFailure}。这是执行问题不是工程问题——不会退回只能产出脚本的回退生成器。请重试或查看 agent 日志。`);
    }
    return { implementations: await this.codeGenerator.generate({ archive, inspection, decisions }) };
  }

  private async inspectCandidate(input: {
    candidate: SkillAssetRecord;
    files: Record<string, Uint8Array>;
    inspection: ProjectInspection;
    decisions: ToolDecision[];
    baseAssetId: string;
    generations: PortableGeneration[];
  }): Promise<ProjectInspection> {
    const decoded: Record<string, string> = {};
    for (const [name, bytes] of Object.entries(input.files)) {
      try { decoded[name] = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch {}
    }
    if (!this.diagnostics) return conflict("静态诊断服务不可用，不能确认生成候选");
    let diagnosis;
    try { diagnosis = await this.diagnostics.diagnose(input.candidate); }
    catch { return conflict("生成候选的静态诊断执行失败，候选未被采纳；请检查 uv、锁文件和扫描器配置"); }
    if (diagnosis.digest !== input.candidate.artifactSha256) return conflict("生成候选的静态诊断与资产不匹配");
    const candidateInspection = inspectProject({
      assetId: input.candidate.assetId,
      assetDigest: input.candidate.artifactSha256,
      files: decoded,
      skillFile: input.candidate.skillFile,
      diagnosis,
    });
    candidateInspection.dependencyAnalysis = input.inspection.dependencyAnalysis ? structuredClone(input.inspection.dependencyAnalysis) : undefined;
    candidateInspection.runtimeCapabilities = input.inspection.runtimeCapabilities ? structuredClone(input.inspection.runtimeCapabilities) : undefined;
    if (candidateInspection.skill.status !== "COMPLIANT") {
      const errors = candidateInspection.skill.findings.filter(item => item.severity === "ERROR")
        .map(item => `${item.code}: ${item.message}`).join("；");
      return conflict(`生成候选不符合 Skill 包规范，候选未被采纳：${errors || "Skill 检查未通过"}`);
    }
    candidateInspection.tools = input.inspection.tools.map(tool => {
      const decision = input.decisions.find(item => item.toolId === tool.toolId && item.baseAssetId === input.baseAssetId)!;
      const generation = input.generations.find(item => item.toolId === tool.toolId)!;
      if (decision.form === "SCRIPT") {
        const entrypoint = generation.entrypoint ?? generation.files.find(name => CODE_FILE.test(name))!;
        const sample = tool.samples.find(item => item.input && typeof item.input === "object" && !Array.isArray(item.input))?.input as Record<string, unknown> | undefined;
        const inputSchema = tool.inputSchema ?? (sample ? {
          type: "object",
          properties: Object.fromEntries(Object.entries(sample).map(([name, value]) => [name,
            value === null ? {} : Array.isArray(value) ? { type: "array" } : { type: typeof value === "object" ? "object" : typeof value }])),
          additionalProperties: true,
        } : null);
        return {
          ...tool,
          inputSchema,
          sourcePaths: [entrypoint],
          language: languageOfSourcePaths([entrypoint]),
          kind: "SCRIPT" as const,
          portability: "PORTABLE_SCRIPT" as const,
          entrypoint: { kind: (/\.py$/iu.test(entrypoint) ? "PYTHON" : "NODE") as "PYTHON" | "NODE", path: entrypoint },
          findings: tool.inputSchema || !sample ? [] : [{ code: "SAMPLE_INPUT_HINTS", severity: "INFO" as const, path: entrypoint, line: 1, message: "输入字段来自原始样例，仅作调用提示，不是完整源 Schema" }],
        };
      }
      const generatedFiles = generation.files.filter(name => CODE_FILE.test(name));
      return {
        ...tool,
        sourcePaths: generatedFiles,
        language: languageOfSourcePaths(generatedFiles),
        kind: "MCP" as const,
        portability: "PORTABLE_MCP" as const,
        entrypoint: undefined,
        findings: [],
      };
    });
    return candidateInspection;
  }
}
