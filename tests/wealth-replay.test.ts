import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeterministicRubricJudge,
  loadEvalPack,
  ReplayRuntimeAdapter,
  runEvaluation,
} from "../src/index.js";

describe("wealth management professional value replay", () => {
  it("reproduces the expert-calibrated professional gains without claiming Runtime identity", async () => {
    const pack = await loadEvalPack(
      path.resolve("packs/finance/wealth-management/eval.yaml"),
    );
    const report = await runEvaluation({
      pack,
      runtime: new ReplayRuntimeAdapter(pack),
      judge: new DeterministicRubricJudge(),
    });

    expect(report.summary).toMatchObject({
      leftWins: 0,
      rightWins: 2,
      ties: 0,
    });
    expect(report.cases.every(item => !item.left.runtimeIdentityVerified)).toBe(true);
    expect(report.cases.every(item => !item.right.runtimeIdentityVerified)).toBe(true);
    expect(report.cases.map(item => item.judge?.dimensions.map(dimension => [
      dimension.id,
      dimension.leftScore,
      dimension.rightScore,
    ]))).toEqual([
      [
        ["professional_fit", 3, 4],
        ["business_completeness", 4, 4],
        ["clarity", 4, 4],
        ["actionability", 3, 4],
      ],
      [
        ["professional_fit", 4, 4],
        ["business_completeness", 4, 4],
        ["clarity", 4, 4],
        ["actionability", 3, 4],
      ],
    ]);
    expect(report.suggestions).toEqual(expect.arrayContaining([
      expect.objectContaining({ criterionId: "decision-changing-questions" }),
      expect.objectContaining({ criterionId: "decision-tradeoff-language" }),
    ]));
  }, 30_000);
});
