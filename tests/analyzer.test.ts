import { describe, expect, it } from "vitest";
import {
  analyzeSkillAndGenerateCases,
  verifyEvaluationContextSnapshot,
  type EvaluationContextAdapter,
  type ModelAdapter,
} from "../src/index.js";

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

  it("uses an optional host context adapter without coupling to its data source", async () => {
    const contextAdapter: EvaluationContextAdapter = {
      adapterId: "host-customer-context-v1",
      async load(request) {
        expect(request).toMatchObject({
          skillId: "wealth-manager-assistant",
          role: "wealth-manager",
          maximumSeeds: 3,
        });
        return {
          sourceLabel: "客户业务上下文",
          mode: "host_enhanced",
          asOf: "2026-08-31T00:00:00.000Z",
          capabilities: ["customer_profile"],
          redaction: "sanitized",
          seeds: [{
            seedId: "customer-C005",
            title: "陈明财富配置场景",
            scenarioType: "wealth_allocation",
            subject: { ref: "C005", label: "陈明" },
            promptFacts: ["有一笔待配置资金"],
            verificationFacts: ["风险测评当前有效"],
            missingFacts: [],
            tags: ["wealth"],
          }],
          metadata: { sourceKind: "host_adapter" },
        };
      },
    };
    const modelAdapter: ModelAdapter = {
      adapterId: "context-aware-analyzer",
      async complete(request) {
        expect(request.messages[0]?.content).toContain("只能写入 subject 和该种子的 promptFacts");
        const payload = JSON.parse(request.messages[1]?.content || "{}") as Record<string, any>;
        expect(payload.evaluationContext.providerId).toBe("host-customer-context-v1");
        expect(payload.evaluationContext.seeds[0].subject.ref).toBe("C005");
        return {
          modelId: request.model.modelId,
          content: JSON.stringify({
            summary: "测试真实客户配置能力。",
            cases: [{
              caseId: "CASE-C005",
              name: "客户配置",
              taskMode: "single_turn",
              prompt: "请为陈明（C005）准备配置建议。",
              evaluationGoal: "核验客户事实后形成建议。",
              requiredTools: ["customer_profile"],
              rubric: [{
                criterionId: "professional",
                label: "专业判断",
                description: "依据客户事实形成建议。",
                dimension: "professional_fit",
                weight: 1,
                required: true,
                anyOf: [],
                allOf: [],
                noneOf: [],
              }],
            }],
          }),
        };
      },
    };

    const result = await analyzeSkillAndGenerateCases({
      modelAdapter,
      model: { providerId: "test", modelId: "analysis-model", parameters: {} },
      skillId: "wealth-manager-assistant",
      skillSource: "先理解客户，再形成配置建议。",
      role: "wealth-manager",
      maximumCases: 3,
      contextAdapter,
    });

    expect(result.cases[0]?.prompt).toContain("C005");
    expect(result.evaluationContext?.seeds).toHaveLength(1);
    expect(verifyEvaluationContextSnapshot(result.evaluationContext!)).toBe(true);
  });
});
