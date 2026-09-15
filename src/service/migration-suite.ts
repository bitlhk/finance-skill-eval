import { analyzeSkillAndGenerateCases } from "../analyzer.js";
import type { EvalCase } from "../contracts.js";
import type { ConfiguredModelRole } from "./config.js";
import type { ProjectInspection } from "./migration-model.js";

/**
 * The migration test set, generated from the analysis.
 *
 * The platform already knows how to write questions; what it lacked was the grounding. The
 * analysis supplies it -- which Tools the Skill actually calls, what they take and return, and a
 * sample the Skill itself documents. So the model writes the questions, and the analysis decides
 * what a question is allowed to ask for. Nothing here reads the Tool source for scenarios: a
 * scenario the Skill was never written for is a scenario nobody can answer.
 *
 * Writing cases by hand was the alternative, and it made the operator invent the tool surface a
 * second time -- the exact thing the analysis exists to stop.
 */
export type MigrationSuiteGenerator = (input: {
  skillId: string;
  /** Skill instructions and its references, plus the baseline brief below. */
  skillSource: string;
  /** The Tools the analysis found. A question may not require a Tool outside this list. */
  tools: string[];
  maximumCases?: number;
  generationId: string;
  signal?: AbortSignal;
}) => Promise<{ summary: string; cases: EvalCase[] }>;

/**
 * The analysis, written out for the question writer.
 *
 * Only what the analysis actually read: a Tool it could not place gets no contract line, so the
 * brief cannot quietly promise a Tool the package never declared.
 */
export function baselineBrief(inspection: ProjectInspection): string {
  const tools = inspection.tools.map(tool => {
    const lines = [`### ${tool.name}`];
    if (tool.inputSchema) lines.push(`输入 Schema：${JSON.stringify(tool.inputSchema)}`);
    if (tool.outputSchema) lines.push(`输出 Schema：${JSON.stringify(tool.outputSchema)}`);
    const described = tool.evidence.filter(item => item.detail).map(item => `${item.detail}（${item.path}:${item.line}）`);
    if (described.length) lines.push(`Skill 里的说明：${described.join('；')}`);
    const samples = tool.samples.slice(0, 2).map(sample => JSON.stringify(sample.input));
    if (samples.length) lines.push(`Skill 文档中出现的样例输入：${samples.join('、')}`);
    return lines.join('\n');
  });
  return [
    '# 这个 Skill 实际调用的工具（来自对 Skill 的分析）',
    '',
    '出题只能围绕这些工具，`requiredTools` 只能从中选择。工具接受的输入形状就是下面写的这些，',
    '不要发明工具里不存在的业务对象。',
    '',
    ...tools,
  ].join('\n');
}

/** The analyzer role must be configured; there is no rules fallback for writing questions. */
export async function generateSuiteWithAnalyzer(
  input: { skillId: string; skillSource: string; tools: string[]; maximumCases?: number; generationId: string; signal?: AbortSignal },
  model: () => ConfiguredModelRole,
): Promise<{ summary: string; cases: EvalCase[] }> {
  const role = model();
  if (!role.configured || !role.adapter) throw new Error('出题模型未配置，无法从分析生成测试集');
  return analyzeSkillAndGenerateCases({
    modelAdapter: role.adapter,
    model: role.model,
    skillId: input.skillId,
    skillSource: input.skillSource,
    maximumCases: input.maximumCases ?? 4,
    generationId: input.generationId,
    signal: input.signal,
    caseDesignContext: {
      allowedTools: input.tools,
      supportedTaskModes: ['single_turn'],
      // A seed is a business object and a task scope, not a question to copy: the writer still has
      // to produce its own task. The tool's own usage line is the honest seed the analysis has.
      seedTasks: input.tools.map(name => ({ name, prompt: `使用 ${name} 完成一次业务查询或计算`, requiredTools: [name] })),
    },
  });
}
