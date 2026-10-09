import path from "node:path";
import { DeterministicRubricJudge } from '../src/judge.js';
import { describe, expect, it, vi } from "vitest";
import {
  loadEvalPack,
  ModelCandidateJudge,
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
    metadata: { toolEvidence: [{ tool: "read_file", resultDigest: "private-document-digest" }, { tool: "prepare_context", result: "verified-business-fact" }] },
  };
}

describe("model pairwise judge", () => {
  it.each([
    ['无余额信息', '未提供金额', '均未满足'],
    ['余额 12,345.67 CNY', '余额 12345.67 CNY', '均满足'],
    ['余额 12345.67', '余额 12,345.67', '未全部满足'],
  ])('reports actual rule coverage for tied answers: %s / %s', async (leftOutput, rightOutput, summary) => {
    const pack = await loadEvalPack(path.resolve('packs/finance/investment-research/eval.yaml'));
    const evalCase = { ...pack.cases[0]!, rubric: [
      { criterionId: 'amount', label: 'Amount', description: 'Synthetic amount', dimension: 'business_completeness' as const,
        weight: 1, allOf: [], anyOf: ['(?<![\\d,])12,?345\\.67(?!\\d)'], noneOf: [] },
      { criterionId: 'currency', label: 'Currency', description: 'Currency present', dimension: 'business_completeness' as const,
        weight: 1, allOf: ['CNY'], anyOf: [], noneOf: [] },
    ] };
    const result = await new DeterministicRubricJudge().compare({ evalCase,
      left: { ...evidence('left', evalCase.caseId), output: leftOutput },
      right: { ...evidence('right', evalCase.caseId), output: rightOutput }, profile: pack.judgeProfile });
    expect(result.winner).toBe('tie');
    expect(result.summary).toContain(summary);
  });
  it('does not turn an empty rule into a perfect professional score',async()=>{
    const pack=await loadEvalPack(path.resolve('packs/finance/auto-insurance-advisor-online/eval.yaml'));
    const evalCase=pack.cases[0];
    await expect(new DeterministicRubricJudge().compare({evalCase,left:evidence('left',evalCase.caseId),right:evidence('right',evalCase.caseId),profile:pack.judgeProfile})).rejects.toThrow(/模型 Judge/);
  });
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
          dimensions: [...pack.judgeProfile.dimensions].reverse().map(dimension => ({
            id: dimension.id,
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
    expect(complete.mock.calls[0]?.[0].messages[1]?.content).not.toContain("private-document-digest");
    expect(complete.mock.calls[0]?.[0].messages[1]?.content).toContain("verified-business-fact");
    expect(complete.mock.calls[1]?.[0].messages.at(-1)?.content).toContain("不要复述 responseContract");
    const contract = JSON.parse(complete.mock.calls[0]![0].messages[1]!.content).responseContract;
    expect(contract.dimensions.every((dimension: Record<string, unknown>) => !("label" in dimension))).toBe(true);
    expect(result.dimensions.map(dimension => dimension.label)).toEqual(pack.judgeProfile.dimensions.map(dimension => dimension.label));
  });
  it('scores a migrated candidate without inventing a winning side',async()=>{
    const pack=await loadEvalPack(path.resolve('packs/finance/investment-research/eval.yaml'));
    const complete=vi.fn<ModelAdapter['complete']>().mockResolvedValue({modelId:'judge-model',content:JSON.stringify({confidence:'high',summary:'候选满足主要业务要求。',
      dimensions:[...pack.judgeProfile.dimensions].reverse().map(dimension=>({id:dimension.id,score:3,reason:'证据充分。'}))})});
    const evalCase=pack.cases[0]!,result=await new ModelCandidateJudge({adapterId:'candidate-test',complete},pack.models.judge).compare({
      evalCase,left:evidence('left',evalCase.caseId),right:evidence('right',evalCase.caseId),profile:pack.judgeProfile,
    });
    expect(result.winner).toBe('tie');expect(result.dimensions.every(dimension=>dimension.leftScore===dimension.rightScore&&dimension.rightScore===3)).toBe(true);
    expect(complete.mock.calls[0]?.[0].messages[0]?.content).toContain('不选择胜方');
    expect(complete.mock.calls[0]?.[0].messages[1]?.content).toContain('candidateOutput');
    expect(complete.mock.calls[0]?.[0].messages[1]?.content).not.toContain('private-document-digest');
    const contract=JSON.parse(complete.mock.calls[0]![0].messages[1]!.content).responseContract;
    expect(contract.dimensions.every((dimension:Record<string,unknown>)=>!('label' in dimension))).toBe(true);
    expect(result.dimensions.map(dimension=>dimension.label)).toEqual(pack.judgeProfile.dimensions.map(dimension=>dimension.label));
  });

  it('retries when dimension ids are duplicated',async()=>{
    const pack=await loadEvalPack(path.resolve('packs/finance/investment-research/eval.yaml'));
    const valid=pack.judgeProfile.dimensions.map(dimension=>({id:dimension.id,aScore:2,bScore:3,reason:'有效判断。'}));
    const complete=vi.fn<ModelAdapter['complete']>()
      .mockResolvedValueOnce({modelId:'judge-model',content:JSON.stringify({winner:'B',confidence:'medium',summary:'重复维度。',dimensions:[valid[0],valid[0],valid[2],valid[3]]})})
      .mockResolvedValueOnce({modelId:'judge-model',content:JSON.stringify({winner:'B',confidence:'medium',summary:'维度完整。',dimensions:valid})});
    const evalCase=pack.cases[0]!;
    const result=await new ModelPairwiseJudge({adapterId:'duplicate-test',complete},pack.models.judge).compare({
      evalCase,left:evidence('left',evalCase.caseId),right:evidence('right',evalCase.caseId),profile:pack.judgeProfile,
    });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(result.dimensions).toHaveLength(4);
  });
});
