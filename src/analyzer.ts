import { z } from "zod";
import type { ModelAdapter } from "./adapters.js";
import { evalCaseSchema, type EvalCase, type ModelRef } from "./contracts.js";

const generatedCasesSchema = z.strictObject({
  summary: z.string().min(1),
  cases: z.array(evalCaseSchema.omit({ replay: true })).min(1).max(8),
});

function parseJsonObject(raw: string): unknown {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1);
  return JSON.parse(candidate.trim());
}

export async function analyzeSkillAndGenerateCases(input: {
  modelAdapter: ModelAdapter;
  model: ModelRef;
  skillId: string;
  skillSource: string;
  domainContext?: string;
  maximumCases?: number;
}): Promise<{ summary: string; cases: EvalCase[] }> {
  const maximumCases = Math.min(Math.max(input.maximumCases ?? 4, 1), 8);
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
          `最多生成 ${maximumCases} 条案例。只返回 JSON。`,
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          skillId: input.skillId,
          domainContext: input.domainContext ?? null,
          skillSource: input.skillSource,
          outputContract: {
            summary: "string",
            cases: "EvalCase[] without replay",
          },
        }),
      },
    ],
  });
  const generated = generatedCasesSchema.parse(parseJsonObject(response.content));
  return generated;
}
