import path from "node:path";
import { describe, expect, it } from "vitest";
import {workspaceFilesSchema,workspaceFilesDigest} from '../src/contracts.js';
import {
  evalPackFileSchema,
  fingerprint,
  loadEvalPack,
} from "../src/index.js";

const packFile = path.resolve("packs/finance/investment-research/eval.yaml");
const riskReviewPackFile = path.resolve("packs/finance/risk-review/eval.yaml");

describe("Eval Pack contracts", () => {
  it("loads the investment research pack with independent model roles", async () => {
    const pack = await loadEvalPack(packFile);

    expect(pack.cases.map(item => item.caseId)).toEqual([
      "IR-VALUE-001",
      "IR-VALUE-002",
    ]);
    expect(pack.models.analyzer.modelId).toBe("glm-5.2");
    expect(pack.models.execution.left.modelId).toBe("glm-5.2");
    expect(pack.models.judge.modelId).toBe("glm-5.2");
    expect(pack.packFingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects unknown frozen contract fields", () => {
    const valid = {
      schemaVersion: "finance.skill-eval.pack.v1",
      packId: "test",
      version: "1.0.0",
      domain: "finance",
      targetSkillId: "target",
      targetSkillVersion: "1.0.0",
      description: "test pack",
      models: {
        analyzer: { providerId: "host", modelId: "analyzer" },
        execution: {
          left: { providerId: "host", modelId: "left" },
          right: { providerId: "host", modelId: "right" },
        },
        judge: { providerId: "host", modelId: "judge" },
      },
      variants: {
        left: { mode: "without_target_skill", skillId: "target" },
        right: { mode: "skill_version", skillId: "target", version: "1.0.0" },
      },
      judgeProfileFile: "judge.yaml",
      caseFiles: ["case.yaml"],
      unsupportedExecutionOverride: true,
    };

    expect(() => evalPackFileSchema.parse(valid)).toThrow(/Unrecognized key/);
  });

  it("loads the frozen risk review comparison cases", async () => {
    const pack = await loadEvalPack(riskReviewPackFile);

    expect(pack.targetSkillId).toBe("transfer-risk-review");
    expect(pack.variants.left.mode).toBe("without_target_skill");
    expect(pack.variants.right.mode).toBe("skill_version");
    expect(pack.cases.map(item => item.caseId)).toEqual([
      "RR-VALUE-001",
      "RR-VALUE-002",
      "RR-VALUE-003",
    ]);
    expect(pack.cases.every(item => item.requiredTools.includes("fraud_transfer_risk_assess")))
      .toBe(true);
  });

  it("produces stable fingerprints independent of object key order", () => {
    expect(fingerprint({ a: 1, b: 2 })).toBe(fingerprint({ b: 2, a: 1 }));
  });
});
it('rejects NUL content that could alias another case file manifest digest',()=>{
  const ambiguous=[{path:'a',content:'b\0c\0d'}];
  expect(workspaceFilesSchema.safeParse(ambiguous).success).toBe(false);
  expect(()=>workspaceFilesDigest(ambiguous)).toThrow();
  expect(workspaceFilesSchema.safeParse([{path:'a',content:'b'},{path:'c',content:'d'}]).success).toBe(true);
});
