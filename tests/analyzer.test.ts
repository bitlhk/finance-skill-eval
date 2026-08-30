import { describe, expect, it } from "vitest";
import { analyzeSkillAndGenerateCases, type ModelAdapter } from "../src/index.js";

describe("Skill analyzer", () => {
  it("uses a host model adapter and returns validated cases", async () => {
    const adapter: ModelAdapter = {
      adapterId: "test-analyzer",
      async complete(request) {
        expect(request.model.modelId).toBe("analysis-model");
        return {
          modelId: request.model.modelId,
          content: JSON.stringify({
            summary: "测试专业判断，而不是只检查格式。",
            cases: [{
              caseId: "CASE-001",
              name: "专业判断",
              taskMode: "single_turn",
              prompt: "分析一家公司。",
              evaluationGoal: "形成可证伪判断。",
              requiredTools: [],
              rubric: [{
                criterionId: "falsifiable",
                label: "可证伪",
                description: "给出失效条件。",
                dimension: "actionability",
                weight: 1,
                required: true,
                anyOf: ["失效条件"],
                allOf: [],
                noneOf: [],
              }],
            }],
          }),
        };
      },
    };

    const result = await analyzeSkillAndGenerateCases({
      modelAdapter: adapter,
      model: { providerId: "test", modelId: "analysis-model", parameters: {} },
      skillId: "investment-research-assistant",
      skillSource: "先形成研究判断，再列证据和失效条件。",
    });

    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]?.rubric[0]?.criterionId).toBe("falsifiable");
  });
});
