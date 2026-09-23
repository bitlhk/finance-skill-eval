import { analyzeSkillAndGenerateCases } from "../../analyzer.js";
import type { EvalCase } from "../../contracts.js";
import type { ConfiguredModelRole } from "../../service/config.js";

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

/** The analyzer role must be configured; there is no rules fallback for writing questions. */
export async function generateSuiteWithAnalyzer(
  input: { skillId: string; skillSource: string; tools: string[]; documentedInputs?:Array<{toolName:string;input:unknown}>; maximumCases?: number; generationId: string; signal?: AbortSignal },
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
      documentedInputs:input.documentedInputs,
      supportedTaskModes: ['single_turn'],
      // A seed is a business object and a task scope, not a question to copy: the writer still has
      // to produce its own task. The tool's own usage line is the honest seed the analysis has.
      seedTasks: input.tools.map(name => ({ name, prompt: `使用 ${name} 完成一次业务查询或计算`, requiredTools: [name] })),
    },
  });
}
