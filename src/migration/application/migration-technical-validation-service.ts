import { z } from "zod";
import {currentRuntimeRequirements} from '../domain/migration-runtime-requirements.js';
import {currentRuntimeReuse} from '../domain/migration-runtime-reuse.js';
import { supportsImplicitScriptContext, type TechnicalValidation, type ToolInspection } from "../domain/migration-model.js";
import {
  runtimeInjection,
  serviceEnvironment,
} from "../domain/migration-runtime-rules.js";
import { executionConfigurationDigest as configurationDigest } from '../../execution-configuration/execution-configuration.js';
import type { MigrationSkillRepository } from "./migration-skill-repository.js";
import type { MigrationProject } from "../domain/migration-project.js";
import type { MigrationProjectStore } from "./migration-project-store.js";
import { migrationConflict as conflict } from "./migration-errors.js";
import type { MigrationRuntimeConfigurationRepository } from './migration-runtime-configuration-repository.js';
import type { MigrationValidationRunner } from './migration-technical-validator.js';
import type { SkillAssetRecord } from '../../shared/contracts/skill-asset.js';

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

type TestInput = {
  value: unknown;
  source: NonNullable<TechnicalValidation["inputSource"]>;
  fields: string[];
};

function schemaValue(schema: unknown): { available: boolean; value?: unknown } {
  if (!record(schema)) return { available: false };
  if ("const" in schema) return { available: true, value: schema.const };
  if ("default" in schema) return { available: true, value: schema.default };
  if (Array.isArray(schema.examples) && schema.examples.length) return { available: true, value: schema.examples[0] };
  if (Array.isArray(schema.enum) && schema.enum.length) return { available: true, value: schema.enum[0] };
  return { available: false };
}

function automaticTestInput(tool: ToolInspection, provided: unknown): TestInput {
  if (provided !== undefined) {
    if (tool.kind === "MCP" && !record(provided)) return conflict("MCP 工具的业务参数必须是对象");
    return { value: provided, source: "USER", fields: record(provided) ? Object.keys(provided) : [] };
  }
  const sample = tool.samples.find(item => record(item.input));
  if (sample) return { value: sample.input, source: "SOURCE_SAMPLE", fields: Object.keys(sample.input as Record<string, unknown>) };
  if (record(tool.inputSchema)) {
    const properties = record(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
    const required = Array.isArray(tool.inputSchema.required)
      ? tool.inputSchema.required.filter((name): name is string => typeof name === "string")
      : [];
    const value: Record<string, unknown> = {};
    const missing: string[] = [];
    for (const name of required) {
      const resolved = schemaValue(properties[name]);
      if (resolved.available) value[name] = resolved.value;
      else missing.push(name);
    }
    if (missing.length) return conflict(`试运行需要补充真实业务测试值：${missing.join("、")}`);
    return { value, source: "SCHEMA_DEFAULT", fields: Object.keys(value) };
  }
  return { value: {}, source: "EMPTY", fields: [] };
}

export class MigrationTechnicalValidationWorkflow {
  constructor(
    private readonly projects: MigrationProjectStore,
    private readonly skills: MigrationSkillRepository,
    private readonly runtimeConfigs:MigrationRuntimeConfigurationRepository,
    private readonly runner:MigrationValidationRunner,
  ) {}

  async validate(id: string, input: unknown, signal?: AbortSignal) {
    return this.projects.runExclusive(id, async () => {
      const parsed = z.strictObject({
        toolId: z.string().min(1),
        baseAssetId: z.string().min(1),
        request: z.unknown().optional(),
        endpoint: z.string().url().optional(),
        arguments: z.record(z.unknown()).optional(),
      }).parse(input);
      const project = await this.projects.get(id);
      const asset = project.candidate ?? project.source;
      if (parsed.baseAssetId !== asset.assetId) return conflict("资产已变化，请刷新后重新验证");
      const result=await this.execute(id,project,asset,parsed,signal);
      const sample=parsed.arguments??parsed.request;
      if(sample!==undefined)await this.runtimeConfigs.saveValidationInput?.(id,parsed.toolId,sample);
      (project.technicalValidations ??= []).push(result);
      await this.projects.save(project);
      return result;
    });
  }

  /** Validate an immutable experiment asset without changing the active candidate or its validation history. */
  async validateIsolated(id:string,asset:SkillAssetRecord,toolId:string,signal?:AbortSignal):Promise<TechnicalValidation>{
    const project=await this.projects.get(id);
    return this.execute(id,project,asset,{toolId,baseAssetId:asset.assetId},signal,true);
  }

  private async execute(id:string,project:MigrationProject,asset:SkillAssetRecord,
    parsed:{toolId:string;baseAssetId:string;request?:unknown;endpoint?:string;arguments?:Record<string,unknown>},
    signal?:AbortSignal,isolated=false):Promise<TechnicalValidation>{
      const inspection = project.inspection;
      if (!inspection) return conflict("请先完成 Tool 检查");
      const requirements=currentRuntimeRequirements(project);
      if (requirements&&!currentRuntimeReuse(project)&&(!('requirementsDigest' in requirements)||project.runtimeDelivery?.requirementsDigest!==requirements.requirementsDigest)) {
        return conflict("Runtime 能力尚未确认：请先核对并复用已有 Runtime；不满足时再将能力需求交给 Builder 适配");
      }
      const tool = inspection.tools.find(item => item.toolId === parsed.toolId);
      if (!tool) return conflict("当前检查结果中不存在这个 Tool");
      if(requirements&&'requiredCapabilities' in requirements&&requirements.requiredCapabilities.some(item=>item.consumerTools.includes(tool.toolId)||item.consumerTools.includes(tool.name)))
        return conflict('此工具依赖原生 Runtime 能力，不能用本地工具试运行冒充能力合同验证；需提供支持该能力的验证器');
      const runtimeConfig = await this.runtimeConfigs.get(id);
      const provided=tool.kind === 'MCP'?parsed.arguments:parsed.request;
      const testInput = automaticTestInput(tool, provided??runtimeConfig.validationInputs?.[tool.toolId]);
      const generated = project.portableGenerations?.find(item => item.toolId === tool.toolId);
      if (generated && !generated.readyForValidation) return conflict("生成候选仍有待办，不能标记技术验证通过");

      const archive = await this.skills.readArchive(asset.assetId);
      const runtimeDependencies = project.sourceInspection?.dependencyAnalysis?.dependencies
        .filter(dependency => dependency.toolIds.includes(tool.toolId)) ?? [];
      if (tool.kind === "SCRIPT" && runtimeDependencies.some(dependency =>
        dependency.owner === "RUNTIME" && dependency.action === "INJECT" && !supportsImplicitScriptContext(dependency))) {
        return conflict("Script 不支持 Runtime 上下文或鉴权注入，请选择 MCP");
      }
      const groupIds = (project.portableGenerations ?? [])
        .filter(generation => generated && JSON.stringify([generation.start, generation.prepare]) === JSON.stringify([generated.start, generated.prepare]))
        .map(generation => generation.toolId);
      const serviceDependencies = project.sourceInspection?.dependencyAnalysis?.dependencies
        .filter(dependency => dependency.toolIds.some(toolId => [tool.toolId, ...groupIds].includes(toolId))) ?? runtimeDependencies;
      const environment = serviceEnvironment(serviceDependencies, runtimeConfig.values);
      const injection = runtimeInjection(runtimeDependencies, runtimeConfig.values, tool.kind === "MCP" ? "HTTP_HEADER" : "SCRIPT_CONTEXT");
      if (injection.missing.length) return conflict(`工具试运行缺少测试配置：${injection.missing.join("、")}`);
      const migrated = Boolean(generated?.start?.length) || Boolean(generated && tool.kind === "MCP");
      const result = tool.kind === "MCP"
        ? await this.runner.validateMcp({
          asset,
          tool,
          archive,
          arguments: testInput.value as Record<string, unknown>,
          headers: injection.headers,
          environment,
          signal,
          ...(migrated ? { service: { start: generated?.start, prepare: generated?.prepare } } : { endpoint: parsed.endpoint ?? "" }),
        })
        : await this.runner.validateScript({ asset, archive, tool, request: testInput.value, context: injection.context, signal });
      result.inputSource = testInput.source;
      result.inputFields = testInput.fields;
      if (runtimeDependencies.length) {
        result.runtimeConfigurationDigest = configurationDigest(runtimeConfig, project.sourceInspection?.dependencyAnalysis?.dependencies);
        if (Object.keys(environment).length || Object.keys(injection.headers).length || Object.keys(injection.context).length) {
          result.error = result.status === "PASSED" ? null : "工具试运行未通过，请检查测试配置、接口权限和实现。原始错误未保存，以避免泄露运行依赖。";
          result.stages = result.stages.map(stage => stage.passed ? stage : { ...stage, message: "此步骤未通过，原始错误未保存以保护运行依赖。" });
        }
        if(!isolated)await this.runtimeConfigs.appendCheck(id, {
          toolId: tool.toolId,
          kind: project.candidate ? "GENERATED_TOOL" : "SOURCE_TOOL",
          status: result.status,
          configurationDigest: result.runtimeConfigurationDigest,
          assetDigest: asset.artifactSha256,
          validationId: result.validationId,
          message: result.status === "PASSED" ? "实际工具调用通过；尚未完成业务效果评估。" : "实际工具调用未通过。",
        });
      }
      return result;
  }

  async list(id: string) {
    return (await this.projects.get(id)).technicalValidations ?? [];
  }

  async currentState(project: MigrationProject) {
    const asset = project.candidate ?? project.source;
    const inspection = project.inspection;
    if (!inspection) return { ready: false, reasons: ["请先完成 Tool 检查"] };
    const runtimeDigest = configurationDigest(
      await this.runtimeConfigs.get(project.id),
      project.sourceInspection?.dependencyAnalysis?.dependencies,
    );
    const latest = new Map<string, TechnicalValidation>();
    for (const result of project.technicalValidations ?? []) {
      if (result.assetDigest === asset.artifactSha256
        && (!result.runtimeConfigurationDigest || result.runtimeConfigurationDigest === runtimeDigest)) {
        latest.set(result.toolId, result);
      }
    }
    const reasons = inspection.tools.flatMap(tool =>
      latest.get(tool.toolId)?.status === "PASSED" ? [] : [`${tool.name} 尚未通过当前资产的技术验证`]);
    return { ready: reasons.length === 0, reasons };
  }
}
