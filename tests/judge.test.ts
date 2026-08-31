import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadEvalPack,
  ModelPairwiseJudge,
  type ModelAdapter,
  type RuntimeExecutionEvidence,
} from "../src/index.js";

function evidence(side: "left" | "right", caseId: string): RuntimeExecutionEvidence {
  return {
    runId: `${caseId}-${side}`,
    side,
    caseId,
    status: "completed",
    modelId: "test-model",
    skillVersion: side === "right" ? "2.1.3" : null,
    output: side === "right" ? "先核验客户约束，再形成方案。" : "直接推荐产品。",
    elapsedMs: 10,
    toolCalls: [{ name: "prepare_context", status: "completed" }],
    loadedSkills: [],
    usage: null,
    runtimeIdentityVerified: true,
    streamCompleted: true,
    error: null,
    traceFingerprint: "a".repeat(64),
    metadata: {},
  };
}

describe("model pairwise judge", () => {
  it("retries once when the model copies the response contract", async () => {
    const pack = await loadEvalPack(
      path.resolve("packs/finance/investment-research/eval.yaml"),
    );
    const complete = vi.fn<ModelAdapter["complete"]>()
      .mockResolvedValueOnce({
        content: JSON.stringify({ responseContract: {} }),
        modelId: "judge-model",
      })
      .mockResolvedValueOnce({
        content: JSON.stringify({
          winner: "B",
          confidence: "high",
          summary: "B 更专业。",
          dimensions: pack.judgeProfile.dimensions.map(dimension => ({
            id: dimension.id,
            label: dimension.label,
            aScore: 2,
            bScore: 4,
            reason: "B 的判断更完整。",
          })),
        }),
        modelId: "judge-model",
      });
    const adapter: ModelAdapter = { adapterId: "retry-test", complete };
    const evalCase = pack.cases[0];
    const result = await new ModelPairwiseJudge(adapter, pack.models.judge).compare({
      evalCase,
      left: evidence("left", evalCase.caseId),
      right: evidence("right", evalCase.caseId),
      profile: pack.judgeProfile,
    });

    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.confidence).toBe("high");
    expect(complete.mock.calls[0]?.[0].messages[1]?.content).toContain("runtimeEvidenceA");
    expect(complete.mock.calls[1]?.[0].messages.at(-1)?.content).toContain("不要复述 responseContract");
  });
});
