import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DeterministicRubricJudge,
  loadEvalPack,
  ReplayRuntimeAdapter,
  runEvaluation,
} from "../src/index.js";

describe("investment research replay", () => {
  it("reproduces the frozen two-case Skill value conclusion", async () => {
    const pack = await loadEvalPack(
      path.resolve("packs/finance/investment-research/eval.yaml"),
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
    expect(report.cases.every(item => item.left.runtimeIdentityVerified)).toBe(true);
    expect(report.cases.every(item => item.right.streamCompleted)).toBe(true);
    expect(report.suggestions.filter(item => item.type === "demonstrated_value"))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ criterionId: "catalyst-window" }),
        expect.objectContaining({ criterionId: "balance-sheet-analysis" }),
        expect.objectContaining({ criterionId: "inventory-receivable-crosscheck" }),
      ]));
  });
});
