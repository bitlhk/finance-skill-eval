import { z } from "zod";
import type { EvaluationContextAdapter, ModelAdapter } from "./adapters.js";
import { evalCaseSchema, type EvalCase, type ModelRef } from "./contracts.js";
import { resolveEvaluationContext } from "./context.js";
import { parseFirstJsonObject } from "./json-response.js";

const generatedCasesSchema = z.strictObject({
  summary: z.string().min(1),
  cases: z.array(evalCaseSchema.omit({ replay: true })).min(1).max(8),
});

export async function analyzeSkillAndGenerateCases(input: {
  modelAdapter: ModelAdapter;
  model: ModelRef;
  skillId: string;
  skillSource: string;
  domainContext?: string;
  contextAdapter?: EvaluationContextAdapter;
  role?: string;
  maximumCases?: number;
}): Promise<{
  summary: string;
  cases: EvalCase[];
  evaluationContext: Awaited<ReturnType<typeof resolveEvaluationContext>>;
}> {
  const maximumCases = Math.min(Math.max(input.maximumCases ?? 4, 1), 8);
  const evaluationContext = await resolveEvaluationContext({
    adapter: input.contextAdapter,
    request: {
      skillId: input.skillId,
      role: input.role,
      maximumSeeds: maximumCases,
    },
  });
  const response = await input.modelAdapter.complete({
    requestId: `analyze-${input.skillId}`,
    model: input.model,
    responseFormat: "json",
    messages: [
      {
        role: "system",
        content: [
          "你是金融 Agent Skill 评测设计专家。",
          "先识别 Skill 真正解决的业务任务，再设计少量高区分度测试题。",
          "重点评价专业判断、业务完整性、表达质量和可执行性。",
          "安全与合规只作为必要底线，不能淹没 Skill 的专业价值。",
          "如果提供了 evaluationContext，只能使用其中脱敏的场景种子辅助出题。",
          "题面事实的硬约束：使用真实 subject 时，只能写入 subject 和该种子的 promptFacts；verificationFacts 的值及其改写、近似值或自然语言标签都只能用于 evaluationGoal，不得出现在题面。",
          "不得补写 promptFacts 之外的客户经历、偏好、金额、情绪或结论。若确需测试额外情境，必须使用不关联真实 subject 的独立‘假设场景’。",
          "输出前逐题自检：真实 subject 题面中的每一项客户事实，都必须能逐项反查到 promptFacts；无法反查的内容删除，改成要求 Runtime 先核验。",
          "宿主上下文只是出题依据，左右 Runtime 仍必须自行调用业务工具核验当前事实。",
          `最多生成 ${maximumCases} 条案例。只返回 JSON。`,
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          skillId: input.skillId,
          domainContext: input.domainContext ?? null,
          evaluationContext,
          skillSource: input.skillSource,
          outputContract: {
            summary: "string",
            cases: "EvalCase[] without replay",
          },
        }),
      },
    ],
  });
  const generated = generatedCasesSchema.parse(parseFirstJsonObject(response.content));
  return { ...generated, evaluationContext };
}
